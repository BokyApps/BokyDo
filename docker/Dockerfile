# ---- build ---------------------------------------------------------------------------------------
FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build
RUN npm install -g pnpm@12.9.1 && npm cache clean --force
WORKDIR /src

# Font binaries are not committed (they are ~36 MB). Fetch the exact releases pinned in
# apps/server/fonts.lock.json, require both the archive and every extracted file to match, then
# verify the same file list again with `sha256sum -c`. This layer only depends on the manifest,
# the checksum list and the fetcher, so source changes do not re-download the archives.
COPY apps/server/fonts.lock.json apps/server/fonts.sha256 /fonts-manifest/
COPY apps/server/scripts/fetch-fonts.mjs /fonts-manifest/
RUN node /fonts-manifest/fetch-fonts.mjs --lock /fonts-manifest/fonts.lock.json --dir /fonts \
 && cd /fonts \
 && sha256sum -c /fonts-manifest/fonts.sha256

# Install with only manifests first so the dependency layer caches across source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/sync-client/package.json packages/sync-client/
COPY packages/themes/package.json packages/themes/
COPY packages/nlp/package.json packages/nlp/
COPY packages/filter-query/package.json packages/filter-query/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/sync-client packages/sync-client
COPY packages/themes packages/themes
COPY packages/nlp packages/nlp
COPY packages/filter-query packages/filter-query
COPY apps/server apps/server
COPY apps/web apps/web
COPY docker/bokydo /cli/bokydo
RUN pnpm -r build \
 && pnpm --filter @bokydo/server deploy --prod /out \
 && chmod 0755 /cli/bokydo \
 && mkdir -m 0700 /skel-data /skel-db-secret

FROM gcr.io/distroless/nodejs22-debian13:nonroot@sha256:ec2313763dd43931543bd03830466e0c409ce73a487e8d46f10db72d3b816c1c AS runtime-base

# Distroless has not incorporated DSA-6613-1 (zlib) or the libzstd fix for CVE-2026-124851 yet.
# Download the exact fixed packages through Debian's signed repository and carry each library
# with its dpkg inventory, so scanners see the fixed versions.
FROM build AS runtime-security
# The slim build image omits system CAs; reuse the runtime's trust store for HTTPS APT.
COPY --from=runtime-base /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN printf 'deb https://security.debian.org/debian-security trixie-security main\n' > /tmp/security.list \
 && apt-get update -o Dir::Etc::sourcelist=/tmp/security.list -o Dir::Etc::sourceparts=- -o APT::Update::Error-Mode=any \
 && mkdir /security-download /runtime-security \
 && cd /security-download \
 && apt-get install --download-only --no-install-recommends -y \
      -o Dir::Etc::sourcelist=/tmp/security.list -o Dir::Etc::sourceparts=- \
      -o Dir::Cache::archives=/security-download \
      'zlib1g=1:1.3.dfsg+really1.3.1-1+deb13u1' 'libzstd1=1.5.7+dfsg-1+deb13u1' \
 && test "$(ls ./*.deb | wc -l)" -eq 2 \
 && mkdir -p /runtime-security/var/lib/dpkg/status.d \
 && for deb in ./*.deb; do \
      pkg="$(dpkg-deb -f "$deb" Package)" \
      && dpkg-deb -x "$deb" /runtime-security \
      && dpkg-deb -f "$deb" > "/runtime-security/var/lib/dpkg/status.d/$pkg" \
      && rm -rf /package-metadata && mkdir /package-metadata \
      && dpkg-deb -e "$deb" /package-metadata \
      && cp /package-metadata/md5sums "/runtime-security/var/lib/dpkg/status.d/$pkg.md5sums" || exit 1; \
    done

# ---- runtime -------------------------------------------------------------------------------------
# Distroless: no shell, no package manager, runs as uid 65532.
FROM runtime-base AS runtime
COPY --from=runtime-security /runtime-security/ /
WORKDIR /app
ENV NODE_ENV=production
ENV BOKYDO_FONT_DIR=/app/fonts
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /src/apps/server/dist ./dist
COPY --from=build /src/apps/server/drizzle ./drizzle
COPY --from=build /src/apps/web/dist ./public
COPY --from=build /fonts /app/fonts
COPY --from=build /src/apps/server/fonts/LICENSES /app/fonts/LICENSES
COPY --from=build /cli/bokydo /usr/local/bin/bokydo
# Volume mount points owned by the app user, so fresh volumes start out writable by the app
# (Docker copies a mount point's owner and mode into a new named volume): no root init step.
COPY --from=build --chown=65532:65532 /skel-data /data
COPY --from=build --chown=65532:65532 /skel-db-secret /run/bokydo-db
USER nonroot
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["/nodejs/bin/node", "/app/dist/cli.js", "healthcheck"]
CMD ["/app/dist/main.js"]
