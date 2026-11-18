// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Serveur Savoire : API REST, temps reel (WebSocket) et API ouverte.

pub mod access;
pub mod api;
pub mod auth;
pub mod config;
pub mod db;
pub mod domain;
pub mod error;
pub mod options;
pub mod realtime;
pub mod services;
pub mod state;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::http::{HeaderValue, request::Parts};
use axum::routing::{any, delete, get, patch, post, put};
use tower_http::cors::{AllowHeaders, AllowMethods, AllowOrigin, CorsLayer};
use tower_http::trace::TraceLayer;

use crate::api::*;
use crate::config::Config;
use crate::state::AppState;

/// Origines de l'application Tauri, quand DesktopAppOrigins n'est pas configure.
pub const DEFAULT_DESKTOP_ORIGINS: [&str; 3] = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"];

/// Regle CORS : AllowedOrigins (web) + DesktopAppOrigins (bureau, Tauri par
/// defaut). Rien de configure, en Development seulement : les adresses
/// locales (Vite de dev). Jamais « toutes les origines ».
pub fn origin_allowed(settings: &config::Settings, origin: &str) -> bool {
    let origin = origin.trim_end_matches('/');
    let web = settings.str_list("AllowedOrigins");
    let desktop: Vec<String> = if settings.exists("DesktopAppOrigins") {
        settings.str_list("DesktopAppOrigins")
    } else {
        DEFAULT_DESKTOP_ORIGINS.iter().map(|s| s.to_string()).collect()
    };
    if web.iter().chain(desktop.iter()).any(|o| o.trim().trim_end_matches('/').eq_ignore_ascii_case(origin)) {
        return true;
    }
    settings.is_development() && web.is_empty() && is_loopback(origin)
}

fn is_loopback(origin: &str) -> bool {
    let Ok(u) = url::Url::parse(origin) else { return false };
    if u.scheme() != "http" && u.scheme() != "https" {
        return false;
    }
    match u.host() {
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

const MB: usize = 1024 * 1024;

pub fn router(st: AppState) -> Router {
    let cfg = st.config.clone();
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(move |origin: &HeaderValue, _: &Parts| {
            origin.to_str().is_ok_and(|o| origin_allowed(&cfg.get(), o))
        }))
        .allow_methods(AllowMethods::mirror_request())
        .allow_headers(AllowHeaders::mirror_request())
        .allow_credentials(true)
        .max_age(Duration::from_secs(600));

    let attachments = Router::new()
        .route("/api/v1/vaults/{vaultId}/attachments", post(attachments::upload))
        .route(
            "/api/v1/vaults/{vaultId}/attachments/{*path}",
            post(attachments::upload_with_id).get(attachments::download).delete(attachments::delete).put(attachments::place),
        )
        .layer(DefaultBodyLimit::max(attachments::MAX_FILE_SIZE + MB));

    let publication = Router::new()
        .route("/api/v1/vaults/{vaultId}/documents/{docId}/publication", get(publications::get).put(publications::publish).delete(publications::unpublish))
        .route("/api/v1/vaults/{vaultId}/documents/{docId}/publication/content", put(publications::refresh))
        .layer(DefaultBodyLimit::max(publications::MAX_REQUEST_BYTES));

    let small = |kb: usize| DefaultBodyLimit::max(kb * 1024);

    Router::new()
        // Sante
        .route("/health/live", get(misc::live))
        .route("/health/ready", get(misc::ready))
        .route("/openapi.yaml", get(misc::openapi))
        // Compte
        .route("/api/v1/auth/config", get(account::auth_config))
        .route("/api/v1/auth/me", get(account::me).delete(account::delete_me))
        .route("/api/v1/auth/me/usage", get(account::usage))
        .route("/api/v1/me/access-tokens", get(account::list_tokens).post(account::create_token))
        .route("/api/v1/me/access-tokens/{id}", delete(account::revoke_token))
        .route("/api/v1/agents", get(agents::list).post(agents::create))
        .route("/api/v1/agents/usage", get(agents::usage))
        .route("/api/v1/agents/approvals", get(agents::approvals))
        .route("/api/v1/agents/approvals/{id}/decide", post(agents::decide))
        .route("/api/v1/agents/actions", get(agents::actions))
        .route("/api/v1/agents/{id}", put(agents::update).delete(agents::delete))
        .route("/api/v1/agents/{id}/usage", post(agents::report_usage))
        .route("/api/v1/feedback", post(account::submit_feedback).layer(DefaultBodyLimit::max(account::MAX_FEEDBACK_REQUEST)))
        .route("/api/v1/identity/key", get(sync::identity_key))
        // Administration
        .route("/api/v1/admin/users", get(admin::list_users))
        .route("/api/v1/admin/users/{userId}/disable", post(admin::disable_user))
        .route("/api/v1/admin/users/{userId}", delete(admin::delete_user))
        .route("/api/v1/admin/orphans/purge", post(admin::purge_orphans))
        .route("/api/v1/admin/feedback", get(admin::list_feedback))
        .route("/api/v1/admin/feedback/{id}/screenshot", get(admin::screenshot))
        .route("/api/v1/admin/feedback/{id}/archive", post(admin::archive_feedback))
        .route("/api/v1/admin/feedback/{id}", delete(admin::delete_feedback))
        // Vaults et comptes
        .route("/api/v1/users", get(vaults::user_by_email))
        .route("/api/v1/users/{userId}", get(vaults::user_by_id))
        .route("/api/v1/users/{userId}/vaults", get(vaults::list).post(vaults::create))
        .route("/api/v1/vaults/{vaultId}", patch(vaults::rename).delete(vaults::delete))
        .route("/api/v1/vaults/{vaultId}/members", post(vaults::add_member))
        .route("/api/v1/vaults/{vaultId}/members/identity", post(vaults::register_identity))
        .route("/api/v1/vaults/{vaultId}/members/identities", get(vaults::identities))
        .route("/api/v1/vaults/{vaultId}/members/{memberId}", delete(vaults::remove_member))
        // Stockages aveugles
        .route("/api/v1/vaults/{vaultId}/edgesync-blobs/{*key}", get(sync::get_blob).put(sync::put_blob))
        .route("/api/v1/vaults/{vaultId}/key-wrap", get(sync::get_key_wrap).put(sync::put_key_wrap))
        // Partage et droits
        .route("/api/v1/vaults/{vaultId}/sharing", get(sharing::vault_sharing))
        .route("/api/v1/vaults/{vaultId}/sharing/permissions", post(sharing::grant_vault))
        .route("/api/v1/vaults/{vaultId}/sharing/permissions/{targetUserId}", delete(sharing::revoke_vault))
        .route("/api/v1/vaults/{vaultId}/sharing/links", post(sharing::link_vault))
        .route("/api/v1/documents/{docId}/sharing", get(sharing::document_sharing))
        .route("/api/v1/documents/{docId}/sharing/permissions", post(sharing::grant_document))
        .route("/api/v1/documents/{docId}/sharing/permissions/{targetUserId}", delete(sharing::revoke_document))
        .route("/api/v1/documents/{docId}/sharing/links", post(sharing::link_document))
        .route("/api/v1/sharing/links/{linkId}", delete(sharing::revoke_link))
        .route("/api/v1/share/{token}/access", get(sharing::access_link))
        .route("/api/v1/vaults/{vaultId}/acl", get(sharing::acl_get))
        .route("/api/v1/vaults/{vaultId}/acl/inherit", put(sharing::acl_inherit))
        .route("/api/v1/vaults/{vaultId}/acl/entries", put(sharing::acl_set_entry).delete(sharing::acl_remove_entry))
        .route("/api/v1/vaults/{vaultId}/acl/folders/rename", post(sharing::acl_rename_folder))
        .route("/api/v1/vaults/{vaultId}/documents/folders", put(sharing::place_documents))
        .route("/api/v1/vaults/{vaultId}/documents/{docId}/attachments", get(attachments::list_of_note))
        .route("/api/v1/view/internal-grants", post(sharing::internal_grant))
        .route("/api/v1/view/grants", post(sharing::grant_view))
        .route("/api/v1/view/grants/redeem", post(sharing::redeem_view))
        // Pair indexeur
        .route("/api/v1/vaults/{vaultId}/index/{capability}/{method}", post(indexer::call))
        .route("/api/v1/search", post(indexer::search_route))
        .route("/api/v1/vaults/{vaultId}/indexer", get(indexer::get_setting).put(indexer::set_setting))
        .route("/internal/indexer/vaults", get(indexer::internal_vaults))
        .route("/internal/indexer/changes", get(indexer::internal_changes))
        .route("/internal/indexer/vaults/{vaultId}/tree", get(indexer::internal_tree))
        .route("/internal/indexer/vaults/{vaultId}/documents/{docId}", get(indexer::internal_document))
        .route("/internal/indexer/vaults/{vaultId}/files/{fileId}", get(indexer::internal_file))
        .route("/internal/indexer/vaults/{vaultId}/settings/{section}", get(indexer::internal_settings))
        .route("/internal/indexer/vaults/{vaultId}/write", post(agents::internal_write).layer(DefaultBodyLimit::max(4 * 1024 * 1024)))
        // API ouverte
        .route("/api/open/v1/openapi.yaml", get(open::description))
        .route("/api/open/v1/vaults", get(open::rest_vaults))
        .route("/api/open/v1/vaults/{vaultId}/search", post(open::rest_search))
        .route("/api/open/v1/vaults/{vaultId}/notes", get(open::rest_notes))
        .route("/api/open/v1/vaults/{vaultId}/notes/read", get(open::rest_read))
        .route("/api/open/v1/vaults/{vaultId}/query", post(open::rest_query).layer(small(open::MAX_QUERY_BYTES / 1024)))
        .route("/api/mcp", post(open::mcp_post).get(open::mcp_other).delete(open::mcp_other).layer(small(open::MAX_MCP_BYTES / 1024)))
        // Divers
        .route("/api/v1/store/config", get(misc::store_config))
        .route("/api/v1/errors/config", get(misc::errors_config))
        .route("/api/v1/errors/envelope", post(misc::errors_envelope).layer(small(misc::MAX_ENVELOPE_BYTES / 1024)))
        .route("/p/{slug}", get(publications::page))
        // Temps reel
        .route("/hubs/{name}", any(realtime::socket::upgrade))
        .merge(attachments)
        .merge(publication)
        // Kestrel : 30 Mo par requete par defaut.
        .layer(DefaultBodyLimit::max(30_000_000))
        .layer(TraceLayer::new_for_http().on_failure(()))
        .layer(cors)
        .with_state(st)
}

/// L'etat du serveur pour cette configuration : base (migrations), fichiers.
pub async fn build(config: Arc<Config>, content_root: &std::path::Path) -> anyhow::Result<AppState> {
    let settings = config.get();
    let indexer = options::IndexerOptions::from(&settings);
    let errors = indexer.validate();
    if !errors.is_empty() {
        anyhow::bail!("Configuration Indexer invalide : {}", errors.join(" "));
    }
    if settings.str("Jwt:Secret").is_none() {
        tracing::warn!("Jwt:Secret manquant : les liens de partage et les vues integrees ne fonctionneront pas.");
    }
    let conn = settings
        .str("ConnectionStrings:Savoire")
        .ok_or_else(|| anyhow::anyhow!("ConnectionStrings:Savoire manquant (PostgreSQL). En dev : deploy/compose/docker-compose.dev.yml."))?;
    let pool = db::connect(&conn).await?;
    db::migrate::run(&pool).await?;
    seed_default_vault(&pool).await?;
    let raw_root = settings.str_or("Storage:Root", "storage");
    let root = if PathBuf::from(&raw_root).is_absolute() { PathBuf::from(&raw_root) } else { content_root.join(&raw_root) };
    let store = services::storage::ContentStore::new(root)?;
    Ok(AppState::new(pool, config, store))
}

/// Sert l'application sur cet ecouteur (jusqu'a l'arret).
pub async fn serve(st: AppState, listener: tokio::net::TcpListener) -> anyhow::Result<()> {
    axum::serve(listener, router(st).into_make_service_with_connect_info::<std::net::SocketAddr>())
        .with_graceful_shutdown(shutdown())
        .await?;
    Ok(())
}

/// Demarre le serveur : configuration, base (migrations), taches de fond, ecoute.
pub async fn run() -> anyhow::Result<()> {
    let content_root = std::env::current_dir()?;
    let config = Config::load(&content_root);
    let settings = config.get();
    let st = build(config.clone(), &content_root).await?;
    spawn_background(st.clone());
    let addr = listen_address(&settings);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!(%addr, environment = %settings.environment, "Serveur Savoire pret");
    serve(st, listener).await
}

/// Adresse d'ecoute : SAVOIRE_LISTEN, sinon ASPNETCORE_URLS (premiere),
/// sinon PORT (toutes les interfaces), sinon localhost:5000 (comme Kestrel ;
/// le proxy Vite de dev y renvoie /api et /hubs).
fn listen_address(s: &config::Settings) -> String {
    if let Ok(a) = std::env::var("SAVOIRE_LISTEN") {
        return a;
    }
    if let Some(urls) = s.str("ASPNETCORE_URLS").or_else(|| std::env::var("ASPNETCORE_URLS").ok()) {
        let first = urls.split(';').next().unwrap_or("").trim();
        let hostport = first.split("://").nth(1).unwrap_or(first).trim_end_matches('/');
        let (host, port) = hostport.rsplit_once(':').unwrap_or((hostport, "8080"));
        let host = match host {
            "+" | "*" | "" => "0.0.0.0",
            "localhost" => "127.0.0.1",
            h => h,
        };
        return format!("{host}:{port}");
    }
    match s.str("PORT").or_else(|| std::env::var("PORT").ok()) {
        Some(port) => format!("0.0.0.0:{port}"),
        None => "127.0.0.1:5000".into(),
    }
}

/// Le vault « default », garde pour compatibilite (idempotent).
async fn seed_default_vault(pool: &db::PgPool) -> anyhow::Result<()> {
    sqlx::query("INSERT INTO vaults (id, name, owner_id, created_at) VALUES ('default', 'Default Vault', 'system', now()) ON CONFLICT (id) DO NOTHING")
        .execute(pool)
        .await?;
    Ok(())
}

/// Taches de fond : droits expires (chaque minute), relecture de la
/// configuration, menage des seaux de debit.
pub fn spawn_background(st: AppState) {
    let s1 = st.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(60));
        loop {
            tick.tick().await;
            if let Err(e) = services::accounts::sweep_expired_permissions(&s1).await {
                tracing::warn!(error = %e, "Balayage des droits expires en echec");
            }
            s1.limiter.sweep();
            s1.realtime.limiter.sweep();
        }
    });
    let cfg: Arc<Config> = st.config.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(5));
        loop {
            tick.tick().await;
            cfg.refresh_if_changed();
        }
    });
}

async fn shutdown() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = term => {} }
    tracing::info!("Arret demande");
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn cors_rules() {
        let prod = config::Settings::from_value(json!({ "AllowedOrigins": ["https://app.example/"] }), "Production");
        assert!(origin_allowed(&prod, "https://app.example"));
        assert!(origin_allowed(&prod, "tauri://localhost"));
        assert!(!origin_allowed(&prod, "http://localhost:5173"));
        let dev = config::Settings::from_value(json!({}), "Development");
        assert!(origin_allowed(&dev, "http://localhost:5173"));
        assert!(origin_allowed(&dev, "http://127.0.0.1:3000"));
        assert!(!origin_allowed(&dev, "https://evil.example"));
        let no_desktop = config::Settings::from_value(json!({ "DesktopAppOrigins": [] }), "Production");
        assert!(!origin_allowed(&no_desktop, "tauri://localhost"));
    }

    #[test]
    fn listen_from_aspnet_urls() {
        let s = config::Settings::from_value(json!({ "ASPNETCORE_URLS": "http://+:9080" }), "Production");
        assert_eq!(listen_address(&s), "0.0.0.0:9080");
    }
}
