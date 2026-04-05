FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build

FROM base AS api
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache pandoc py3-weasyprint cairo pango gdk-pixbuf fontconfig ca-certificates ttf-freefont
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data
EXPOSE 3120
CMD ["node", "dist/server.js"]

FROM base AS web
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json
COPY --from=deps /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=deps /app/apps/web/package.json ./apps/web/package.json
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/apps/web/vite.config.ts ./apps/web/vite.config.ts
EXPOSE 5173
CMD ["pnpm", "--dir", "apps/web", "preview", "--host", "0.0.0.0", "--port", "5173"]
