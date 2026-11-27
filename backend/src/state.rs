// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// L'etat partage du serveur : base, configuration, services, temps reel.

use std::sync::{Arc, Mutex};
use std::time::Instant;

use dashmap::DashMap;

use crate::auth::Authenticator;
use crate::config::{Config, Settings};
use crate::db::PgPool;
use crate::options::LimitsOptions;
use crate::realtime::Realtime;
use crate::services::indexer::PeerClient;
use crate::services::quota::Quota;
use crate::services::rate_limit::RateLimiter;
use crate::services::storage::ContentStore;

#[derive(Clone)]
pub struct AppState(pub Arc<Inner>);

pub struct Inner {
    pub db: PgPool,
    pub config: Arc<Config>,
    pub http: reqwest::Client,
    pub store: ContentStore,
    pub quota: Quota,
    pub auth: Authenticator,
    pub peer: PeerClient,
    pub limiter: RateLimiter,
    pub realtime: Realtime,
    /// Tickets d'ecriture des outils d'agents en cours (ADR-033), par id.
    pub agent_tickets: DashMap<String, crate::api::agents::AgentTicket>,
    /// Catalogue des outils du pair, et quand il a ete lu.
    pub agent_catalog: Mutex<Option<(Instant, Vec<serde_json::Value>)>>,
    /// Jetons Notion en attente d'etre repris par l'application (ADR-035).
    pub notion_tickets: DashMap<String, crate::api::notion::NotionTicket>,
    /// Ou travaille chaque personne dans l'editeur, pour l'IA (en memoire : api/editor_context.rs).
    pub editor_contexts: crate::api::editor_context::ContextStore,
    /// Envois de fichiers en attente (outil MCP file_upload_url), par jeton.
    pub upload_slots: DashMap<String, crate::api::open::UploadSlot>,
}

impl std::ops::Deref for AppState {
    type Target = Inner;
    fn deref(&self) -> &Inner {
        &self.0
    }
}

impl AppState {
    pub fn new(db: PgPool, config: Arc<Config>, store: ContentStore) -> Self {
        let http = reqwest::Client::builder()
            .user_agent("savoire-server")
            .build()
            .expect("client HTTP");
        AppState(Arc::new(Inner {
            quota: Quota::new(db.clone(), store.clone()),
            peer: PeerClient::new(http.clone()),
            db,
            config,
            http,
            store,
            auth: Authenticator::new(),
            limiter: RateLimiter::new(),
            realtime: Realtime::new(),
            agent_tickets: DashMap::new(),
            upload_slots: DashMap::new(),
            agent_catalog: Mutex::new(None),
            notion_tickets: DashMap::new(),
            editor_contexts: crate::api::editor_context::ContextStore::new(),
        }))
    }

    pub fn settings(&self) -> Arc<Settings> {
        self.config.get()
    }

    pub fn limits(&self) -> LimitsOptions {
        LimitsOptions::from(&self.settings())
    }
}
