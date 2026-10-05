# ---- build ---------------------------------------------------------------------------------------
FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build
RUN npm install -g pnpm@12.9.1 && npm cache clean --force
WORKDIR /src

# Install with only manifests first so the dependency layer caches across source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/sync-client/package.json packages/sync-client/
COPY packages/themes/package.json packages/themes/
COPY packages/nlp/package.json packages/nlp/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/sync-client packages/sync-client
COPY packages/themes packages/themes
COPY packages/nlp packages/nlp
COPY apps/server apps/server
COPY apps/web apps/web
COPY docker/bokydo /cli/bokydo
RUN pnpm -r build \
 && pnpm --filter @bokydo/server deploy --prod /out \
 && chmod 0755 /cli/bokydo

# ---- runtime -------------------------------------------------------------------------------------
# Distroless: no shell, no package manager, runs as uid 65532.
FROM gcr.io/distroless/nodejs22-debian13:nonroot@sha256:ec2313763dd43931543bd03830466e0c409ce73a487e8d46f10db72d3b816c1c
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /src/apps/server/dist ./dist
COPY --from=build /src/apps/server/drizzle ./drizzle
COPY --from=build /src/apps/web/dist ./public
COPY --from=build /cli/bokydo /usr/local/bin/bokydo
USER nonroot
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["/nodejs/bin/node", "/app/dist/cli.js", "healthcheck"]
CMD ["/app/dist/main.js"]
