# syntax=docker/dockerfile:1
# Dockerfile — Frontend React (Vite)
# Context : racine du repo (pour accéder au workspace pnpm entier)
# DECISION: Multi-stage — node pour build, nginx pour servir le SPA.
# DECISION: nginx proxifie /api et /hubs vers API_URL à l'exécution
#           (pas de rebuild nécessaire si l'URL de l'API change).

FROM node:24-alpine AS build
WORKDIR /repo

# Meme pnpm que le pair indexeur (apps/indexer/Dockerfile) : version figee,
# pas « latest » (un pnpm neuf peut refuser le lockfile).
RUN npm install -g pnpm@11

# Layer cache : manifestes d'abord. L'appli web importe le profil bureau
# (@savoire/desktop, apps/desktop/src) : il est dans le paquet web aussi.
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml frontend/tsconfig.base.json ./frontend/
COPY apps/web/package.json ./apps/web/
COPY apps/desktop/package.json ./apps/desktop/
COPY packages/ ./packages/

RUN cd frontend && pnpm install --frozen-lockfile --filter "@savoire/web..."

COPY frontend/ ./frontend/
COPY apps/web/ ./apps/web/
COPY apps/desktop/package.json apps/desktop/tsconfig.json ./apps/desktop/
COPY apps/desktop/src/ ./apps/desktop/src/
COPY packages/ ./packages/
RUN cd frontend && pnpm --filter @savoire/web build

# ── Image finale : nginx ─────────────────────────────────────────────
FROM nginx:alpine AS final

RUN apk add --no-cache gettext  # fournit envsubst

COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf.template /etc/nginx/templates/default.conf.template

EXPOSE 8080

# nginx Docker image traite automatiquement /etc/nginx/templates/*.template
# via envsubst au démarrage — pas besoin d'entrypoint custom.
CMD ["nginx", "-g", "daemon off;"]
