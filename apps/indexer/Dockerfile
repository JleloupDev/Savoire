# syntax=docker/dockerfile:1
# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Jean Leloup
#
# Savoire Indexer : le pair indexeur (ADR-027), un seul fichier Node.
# Contexte : racine du depot (workspace pnpm), comme apps/web/Dockerfile.
#   docker build -f apps/indexer/Dockerfile -t savoire-indexer .
# Configuration : variables SAVOIRE_INDEXER_* (apps/indexer/README.md).
# Jamais expose : reseau prive avec le backend seulement.

FROM node:24-slim AS build
WORKDIR /repo
RUN npm install -g pnpm@11

# Manifestes d'abord (cache des couches).
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml frontend/tsconfig.base.json ./frontend/
COPY apps/indexer/package.json ./apps/indexer/
COPY packages/ ./packages/
RUN cd frontend && pnpm install --frozen-lockfile --filter "@savoire/indexer..."

COPY apps/indexer/ ./apps/indexer/
RUN cd frontend && pnpm --filter @savoire/indexer build

# ── Image finale : Node 24 seul, le paquet construit, utilisateur non root ──
FROM node:24-slim AS final
ENV NODE_ENV=production \
    SAVOIRE_INDEXER_DATA_DIR=/data \
    SAVOIRE_INDEXER_HOST=0.0.0.0 \
    SAVOIRE_INDEXER_PORT=7070
WORKDIR /app
COPY --from=build /repo/apps/indexer/dist/ ./dist/
# Les index (un SQLite par vault) : volume sur SSD local, jamais un partage SMB/NFS.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 7070
# Vivant tant que le processus repond ; « pret » (/health/ready) sert a l'orchestrateur.
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.SAVOIRE_INDEXER_PORT||7070)+'/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# SIGTERM : arret propre (appels finis, ecritures finies, fichiers fermes).
STOPSIGNAL SIGTERM
CMD ["node", "--enable-source-maps", "dist/indexer.mjs"]
