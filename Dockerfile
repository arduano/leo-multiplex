FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates g++ make python3 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm ci --strict-allow-scripts
COPY tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
RUN npm run build && cp apps/web/THIRD_PARTY_LICENSES.txt dist/web/THIRD_PARTY_LICENSES.txt

FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json LICENSE THIRD_PARTY_NOTICES.md ./
USER 1000:100
CMD ["node", "dist/apps/server/src/main.js"]
