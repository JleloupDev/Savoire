# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Jean Leloup
#
# Page de connexion de Savoire : celle de Zitadel (login v2, licence MIT),
# retouchee pour entrer sans mot de passe. Voir README.md.
#
#   docker build -t savoire-login:local deploy/compose/zitadel-login
#
# ZITADEL_VERSION doit suivre l'image de Zitadel (docker-compose*.yml).
ARG ZITADEL_VERSION=v4.16.0

FROM node:24.22.1-alpine AS build
ARG ZITADEL_VERSION
RUN apk add --no-cache git && corepack enable
WORKDIR /src
# Seulement ce qu'il faut : la page, ses deux paquets, les fichiers .proto.
RUN git clone --depth 1 --branch "${ZITADEL_VERSION}" --filter=blob:none --sparse \
      https://github.com/zitadel/zitadel.git . \
 && git sparse-checkout set apps/login packages proto
COPY patches /savoire/patches
COPY locales /savoire/locales
COPY merge-locales.mjs /savoire/
RUN git apply --verbose /savoire/patches/*.patch \
 && node /savoire/merge-locales.mjs /savoire/locales apps/login/locales
RUN pnpm install --frozen-lockfile --filter "@zitadel/login..." --filter "."
RUN cd packages/zitadel-proto && pnpm exec buf generate ../../proto \
 && cd ../zitadel-client && pnpm run build \
 && cd ../../apps/login && NEXT_TELEMETRY_DISABLED=1 pnpm run build

# Meme image finale que celle de Zitadel (apps/login/Dockerfile).
FROM node:24.22.1-alpine
WORKDIR /app
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs
RUN mkdir -p /.env-file && touch /.env-file/.env && chown -R nextjs:nodejs /.env-file
COPY --from=build --chown=nextjs:nodejs /src/apps/login/.next/standalone ./
USER nextjs
ENV HOSTNAME="::" \
    PORT="3000" \
    NODE_ENV="production" \
    NODE_OPTIONS="--use-openssl-ca --require /app/load-ssl-cert-dir.cjs" \
    SSL_CERT_FILE="/etc/ssl/certs/ca-certificates.crt" \
    ZITADEL_TLS_ENABLED="false" \
    OTEL_SERVICE_NAME="zitadel-login" \
    OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD ["/usr/local/bin/node", "/app/healthcheck.mjs", "/ui/v2/login/ready"]
ENTRYPOINT ["/app/entrypoint.sh", "node", "apps/login/server.js"]
