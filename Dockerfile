FROM node:22-alpine AS base
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/package.json
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build

FROM base AS api
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache pandoc chromium fontconfig ca-certificates
COPY --from=deps /app/node_modules ./node_modules
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
CMD ["npm", "run", "preview", "--", "--host", "0.0.0.0", "--port", "5175"]
