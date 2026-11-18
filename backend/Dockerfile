# syntax=docker/dockerfile:1
# Dockerfile — serveur Savoire (API REST, temps reel, API ouverte), en Rust.
# Contexte : racine du depot (docker-compose.build.yml, images.yml).

# Versions figees (M9) : une image ne change pas sous nos pieds ; on les monte a la main.
FROM rust:1.99-bookworm AS build
WORKDIR /src
# Dependances d'abord (cache des couches) : un projet vide avec le meme Cargo.toml.
COPY backend/Cargo.toml backend/Cargo.lock backend/
RUN mkdir -p backend/src && echo 'fn main() {}' > backend/src/main.rs && echo '' > backend/src/lib.rs \
    && cargo build --release --manifest-path backend/Cargo.toml && rm -rf backend/src
COPY backend/ backend/
RUN touch backend/src/main.rs backend/src/lib.rs && cargo build --release --manifest-path backend/Cargo.toml

FROM debian:bookworm-slim AS final
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Meme utilisateur que l'image .NET d'avant (uid 1654) : un volume /data
# existant reste lisible.
RUN groupadd --gid 1654 app && useradd --uid 1654 --gid app --no-create-home app \
    && mkdir -p /data && chown app:app /data
COPY --from=build /src/backend/target/release/savoire-server /app/savoire-server
ENV Storage__Root=/data \
    SAVOIRE_LISTEN=0.0.0.0:8080
EXPOSE 8080
USER app
ENTRYPOINT ["/app/savoire-server"]
