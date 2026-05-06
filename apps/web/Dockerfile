# syntax=docker/dockerfile:1
# Dockerfile — Frontend React (Vite)
# Context : racine du repo (pour accéder au workspace pnpm entier)
# DECISION: Multi-stage — node pour build, nginx pour servir le SPA.
# DECISION: nginx proxifie /api et /hubs vers API_URL à l'exécution
#           (pas de rebuild nécessaire si l'URL de l'API change).

FROM node:22-alpine AS build
WORKDIR /repo

RUN corepack enable && corepack prepare pnpm@latest --activate

# Layer cache : manifestes d'abord
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml ./frontend/
COPY apps/web/package.json ./apps/web/
COPY packages/ ./packages/

RUN cd frontend && pnpm install --frozen-lockfile

COPY frontend/ ./frontend/
COPY apps/web/ ./apps/web/
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
