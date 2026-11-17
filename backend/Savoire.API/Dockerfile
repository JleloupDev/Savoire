# syntax=docker/dockerfile:1
# Dockerfile — Server API + SignalR
# DECISION: Multi-stage build pour image minimale (~100 MB).
# Context : racine du repo (azure.yaml context: .)

# Versions figees (M9) : une image ne change pas sous nos pieds ; on les monte a la main.
FROM mcr.microsoft.com/dotnet/aspnet:10.0.14 AS base
WORKDIR /app
EXPOSE 8080

FROM mcr.microsoft.com/dotnet/sdk:10.0.403 AS build
WORKDIR /src

# Restauration des dépendances (layer cache) — copier tous les csproj d'abord
COPY backend/Savoire.API/Savoire.API.csproj backend/Savoire.API/
COPY backend/Savoire.Domain/Savoire.Domain.csproj backend/Savoire.Domain/
COPY backend/Savoire.Application/Savoire.Application.csproj backend/Savoire.Application/
COPY backend/Savoire.Infrastructure/Savoire.Infrastructure.csproj backend/Savoire.Infrastructure/
RUN dotnet restore backend/Savoire.API/Savoire.API.csproj

# Build + publish
COPY backend/ backend/
RUN dotnet build backend/Savoire.API/Savoire.API.csproj -c Release -o /app/build

FROM build AS publish
RUN dotnet publish backend/Savoire.API/Savoire.API.csproj -c Release -o /app/publish

FROM base AS final
WORKDIR /app
# DECISION: Volume /data pour le vault storage (monté par Docker Compose ou ACA)
ENV Storage__Root=/data
COPY --from=publish /app/publish .
# Pas root (M9) : l'utilisateur « app » de l'image (uid 1654). Le dossier
# /data lui appartient ; un volume neuf monte dessus en herite.
RUN mkdir -p /data && chown app:app /data
USER app
ENTRYPOINT ["dotnet", "Savoire.Server.dll"]

