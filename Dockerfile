# One image: the API serves the built web app. Build from the repo root.
FROM node:22-alpine AS web
WORKDIR /web
COPY apps/web/package*.json ./
RUN npm ci
COPY apps/web/ ./
RUN npm run build

FROM node:22-alpine AS api
WORKDIR /api
COPY apps/api/package*.json ./
RUN npm ci
COPY apps/api/tsconfig.json ./
COPY apps/api/src ./src
RUN npx tsc -p tsconfig.json

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production WEB_DIST=/app/web STORAGE_DIR=/app/storage
COPY apps/api/package*.json ./
RUN npm ci --omit=dev && mkdir -p /app/storage && chown node:node /app/storage
COPY --from=api /api/dist ./dist
COPY --from=web /web/dist ./web
COPY apps/api/db ./db
COPY apps/api/scripts ./scripts
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:4000/api/health || exit 1
CMD ["node", "dist/main.js"]
