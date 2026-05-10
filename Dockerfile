FROM node:22-bookworm-slim AS base
ENV CI=true
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/package.json
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build

FROM base AS api
WORKDIR /app
ENV NODE_ENV=production
RUN --mount=type=cache,target=/var/cache/apt \
  --mount=type=cache,target=/var/lib/apt \
  apt-get update \
  && apt-get install -y --no-install-recommends pandoc fontconfig ca-certificates libnss3 libxss1 libasound2 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libx11-xcb1 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libcups2 libdrm2 libpango-1.0-0 libatk1.0-0 libnspr4 fonts-liberation \
  && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /root/.cache/puppeteer /root/.cache/puppeteer
COPY --from=deps /app/package.json ./package.json
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data
EXPOSE 3120
CMD ["node", "dist/server.js"]

FROM base AS web
WORKDIR /app/apps/web
ENV NODE_ENV=production
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=build /app/apps/web/package.json ./package.json
COPY --from=build /app/apps/web/dist ./dist
COPY --from=build /app/apps/web/vite.config.ts ./vite.config.ts
EXPOSE 5175
CMD ["pnpm", "preview", "--", "--host", "0.0.0.0", "--port", "5175"]
