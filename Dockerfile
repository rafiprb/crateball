# Base images pinned by digest (refresh: docker buildx imagetools inspect node:24-alpine).
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /app
RUN corepack enable
COPY . .
# Baked into the client so it can tell when the server runs a newer release.
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://localhost:8080/health || exit 1
CMD ["node", "dist/server/server.mjs"]
