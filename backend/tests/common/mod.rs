// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Banc d'essai des tests d'integration : une base PostgreSQL neuve par test
// (supprimee a la fin), un dossier temporaire, un fournisseur d'identite de
// test (cle RSA de tests/fixtures, decouverte et JWKS servis en local) et le
// serveur, ecoutant sur un port libre (les hubs se testent en WebSocket).
//
// Serveur PostgreSQL : SAVOIRE_TEST_POSTGRES, sinon le PostgreSQL de dev
// (deploy/compose/docker-compose.dev.yml), avec un role qui cree des bases.
// Injoignable : le test est saute (message sur la sortie d'erreur).

#![allow(dead_code)]

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use savoire_server::config::Config;
use savoire_server::state::AppState;
use serde_json::{Value, json};
use sqlx::Connection;
use tokio_tungstenite::tungstenite::Message;

pub const ADMIN_EMAIL: &str = "admin@test.local";
pub const ADMIN_SUBJECT: &str = "admin-test-subject";
pub const AUDIENCE: &str = "savoire-test-project";
pub const JWT_SECRET: &str = "test-secret-key-for-tests-minimum-32-chars!!";
pub const JWT_ISSUER: &str = "vault-server";
pub const JWT_AUDIENCE: &str = "vault-client";
pub const SERVICE_TOKEN: &str = "indexer-test-token";

pub fn test_server() -> String {
    std::env::var("SAVOIRE_TEST_POSTGRES").unwrap_or_else(|_| "Host=127.0.0.1;Port=5432;Username=postgres;Password=postgres".into())
}

pub struct TestApp {
    pub base: String,
    pub idp: String,
    pub state: AppState,
    pub http: reqwest::Client,
    pub db_name: String,
    pub storage: PathBuf,
    admin_conn: String,
}

impl Drop for TestApp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.storage);
        let name = self.db_name.clone();
        let conn = self.admin_conn.clone();
        // La base part a la fin : une connexion a part, hors du runtime du test.
        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            rt.block_on(async move {
                if let Ok(mut c) = sqlx::PgConnection::connect_with(&savoire_server::db::parse_connection_string(&conn).unwrap()).await {
                    let _ = sqlx::query(sqlx::AssertSqlSafe(format!("DROP DATABASE IF EXISTS \"{name}\" WITH (FORCE)"))).execute(&mut c).await;
                }
            });
        })
        .join()
        .ok();
    }
}

async fn fake_idp() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let issuer = format!("http://{addr}");
    let jwks: Value = serde_json::from_str(include_str!("../fixtures/test-idp-jwks.json")).unwrap();
    let iss = issuer.clone();
    let app = axum::Router::new()
        .route(
            "/.well-known/openid-configuration",
            axum::routing::get(move || {
                let iss = iss.clone();
                async move { axum::Json(json!({ "issuer": iss, "jwks_uri": format!("{iss}/jwks") })) }
            }),
        )
        .route("/jwks", axum::routing::get(move || {
            let j = jwks.clone();
            async move { axum::Json(j) }
        }));
    tokio::spawn(async move { axum::serve(listener, app).await.ok() });
    issuer
}

pub struct Options {
    pub extra: Value,
}

impl Default for Options {
    fn default() -> Self {
        Options { extra: json!({}) }
    }
}

/// Le serveur, ou None si PostgreSQL est injoignable (test saute).
pub async fn start(opts: Options) -> Option<TestApp> {
    let admin_conn = test_server();
    let mut admin = match sqlx::PgConnection::connect_with(&savoire_server::db::parse_connection_string(&admin_conn).ok()?.database("postgres")).await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("PostgreSQL injoignable ({e}) : test saute.");
            return None;
        }
    };
    let db_name = format!("savoire_test_{}", uuid::Uuid::new_v4().simple());
    sqlx::query(sqlx::AssertSqlSafe(format!("CREATE DATABASE \"{db_name}\""))).execute(&mut admin).await.unwrap();
    let storage = std::env::temp_dir().join("savoire-rs-tests").join(uuid::Uuid::new_v4().simple().to_string());
    std::fs::create_dir_all(&storage).unwrap();
    let idp = fake_idp().await;
    let conn = format!("{};Database={db_name}", admin_conn.trim_end_matches(';'));
    let mut overrides = json!({
        "ConnectionStrings": { "Savoire": conn },
        "Storage": { "Root": storage.to_string_lossy() },
        "Jwt": { "Secret": JWT_SECRET, "Issuer": JWT_ISSUER, "Audience": JWT_AUDIENCE },
        "Savoire": { "OidcConfigFile": "", "ErrorReportingConfigFile": "" },
        "Auth": {
            "Oidc": { "Authority": idp, "Audience": AUDIENCE, "WebClientId": "web-test-client", "DesktopClientId": "desktop-test-client", "RequireHttpsMetadata": false },
            "AdminEmails": [ADMIN_EMAIL],
        },
        "Limits": { "MinFreeDiskBytes": 0 },
    });
    savoire_server::config::merge(&mut overrides, opts.extra);
    let dir = std::env::temp_dir();
    let config: Arc<Config> = Config::load_with(&dir, overrides);
    let state = savoire_server::build(config, &dir).await.unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr: SocketAddr = listener.local_addr().unwrap();
    let st = state.clone();
    tokio::spawn(async move {
        axum::serve(listener, savoire_server::router(st).into_make_service_with_connect_info::<SocketAddr>()).await.ok()
    });
    Some(TestApp { base: format!("http://{addr}"), idp, state, http: reqwest::Client::new(), db_name, storage, admin_conn })
}

/// Saute le test quand PostgreSQL manque.
#[macro_export]
macro_rules! app {
    () => {
        match common::start(common::Options::default()).await {
            Some(a) => a,
            None => return,
        }
    };
    ($extra:expr) => {
        match common::start(common::Options { extra: $extra }).await {
            Some(a) => a,
            None => return,
        }
    };
}

#[derive(serde::Serialize)]
struct IdpClaims<'a> {
    sub: &'a str,
    iss: &'a str,
    aud: &'a str,
    exp: i64,
    nbf: i64,
    jti: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    email: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    email_verified: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<&'a str>,
}

impl TestApp {
    /// Un jeton d'acces de l'IdP de test (adresse verifiee).
    pub fn token(&self, subject: &str, email: Option<&str>, name: Option<&str>) -> String {
        self.token_with(subject, email, name, true, 1800)
    }

    pub fn token_with(&self, subject: &str, email: Option<&str>, name: Option<&str>, verified: bool, ttl: i64) -> String {
        let now = chrono::Utc::now().timestamp();
        let claims = IdpClaims {
            sub: subject,
            iss: &self.idp,
            aud: AUDIENCE,
            exp: now + ttl,
            nbf: now - 3600,
            jti: uuid::Uuid::new_v4().to_string(),
            email,
            email_verified: email.map(|_| if verified { "true" } else { "false" }),
            name,
        };
        let mut h = Header::new(Algorithm::RS256);
        h.kid = Some("test-key".into());
        let key = EncodingKey::from_rsa_der(include_bytes!("../fixtures/test-idp-key.der"));
        jsonwebtoken::encode(&h, &claims, &key).unwrap()
    }

    /// Un compte neuf : (sujet, jeton). Son compte est cree a la premiere requete.
    pub async fn user(&self, name: &str) -> (String, String) {
        let sub = format!("{name}-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
        let email = format!("{sub}@test.local");
        let t = self.token(&sub, Some(&email), Some(name));
        let r = self.get(&t, "/api/v1/auth/me").await;
        assert_eq!(r.0, 200, "compte {name} : {}", r.1);
        (sub, t)
    }

    pub fn admin_token(&self) -> String {
        self.token(ADMIN_SUBJECT, Some(ADMIN_EMAIL), Some("Test Admin"))
    }

    pub fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    async fn send(&self, rb: reqwest::RequestBuilder, token: &str) -> (u16, Value, reqwest::header::HeaderMap) {
        let rb = if token.is_empty() { rb } else { rb.bearer_auth(token) };
        let res = rb.send().await.unwrap();
        let status = res.status().as_u16();
        let headers = res.headers().clone();
        let text = res.text().await.unwrap();
        let body = serde_json::from_str(&text).unwrap_or(Value::String(text));
        (status, body, headers)
    }

    pub async fn get(&self, token: &str, path: &str) -> (u16, Value) {
        let r = self.send(self.http.get(self.url(path)), token).await;
        (r.0, r.1)
    }

    pub async fn get_h(&self, token: &str, path: &str) -> (u16, Value, reqwest::header::HeaderMap) {
        self.send(self.http.get(self.url(path)), token).await
    }

    pub async fn post(&self, token: &str, path: &str, body: Value) -> (u16, Value) {
        let r = self.send(self.http.post(self.url(path)).json(&body), token).await;
        (r.0, r.1)
    }

    pub async fn post_h(&self, token: &str, path: &str, body: Value) -> (u16, Value, reqwest::header::HeaderMap) {
        self.send(self.http.post(self.url(path)).json(&body), token).await
    }

    pub async fn put(&self, token: &str, path: &str, body: Value) -> (u16, Value) {
        let r = self.send(self.http.put(self.url(path)).json(&body), token).await;
        (r.0, r.1)
    }

    pub async fn patch(&self, token: &str, path: &str, body: Value) -> (u16, Value) {
        let r = self.send(self.http.patch(self.url(path)).json(&body), token).await;
        (r.0, r.1)
    }

    pub async fn delete(&self, token: &str, path: &str) -> (u16, Value) {
        let r = self.send(self.http.delete(self.url(path)), token).await;
        (r.0, r.1)
    }

    /// Un vault de la personne ; rend son id.
    pub async fn vault(&self, sub: &str, token: &str, name: &str) -> String {
        let r = self.post(token, &format!("/api/v1/users/{sub}/vaults"), json!({ "name": name })).await;
        assert_eq!(r.0, 201, "{}", r.1);
        r.1["id"].as_str().unwrap().to_string()
    }

    /// Inscrit un document neuf dans le vault (comme le client avant de le creer).
    pub async fn document(&self, token: &str, vault_id: &str) -> String {
        let doc = uuid::Uuid::new_v4().to_string();
        let mut hub = self.hub("vault", token).await.expect("hub");
        let rejected = hub.invoke("RegisterDocuments", json!([vault_id, [doc]])).await.expect("RegisterDocuments");
        assert_eq!(rejected, json!([]));
        doc
    }

    /// Donne un droit sur le vault (le fait entrer comme membre).
    pub async fn grant_vault(&self, owner_token: &str, vault_id: &str, subject: &str, permission: &str) {
        let r = self.post(owner_token, &format!("/api/v1/vaults/{vault_id}/sharing/permissions"), json!({ "subjectId": subject, "permission": permission })).await;
        assert_eq!(r.0, 200, "{}", r.1);
    }

    /// Jeton limite d'un lien de partage.
    pub async fn link_token(&self, owner_token: &str, path: &str, permission: &str) -> (String, String) {
        let r = self.post(owner_token, path, json!({ "permission": permission })).await;
        assert_eq!(r.0, 200, "{}", r.1);
        let token = r.1["token"].as_str().unwrap().to_string();
        let id = r.1["id"].as_str().unwrap().to_string();
        let a = self.get("", &format!("/api/v1/share/{token}/access")).await;
        assert_eq!(a.0, 200, "{}", a.1);
        (a.1["accessToken"].as_str().unwrap().to_string(), id)
    }

    pub async fn hub(&self, name: &str, token: &str) -> Result<Hub, String> {
        let url = format!("{}/hubs/{name}?access_token={}", self.base.replace("http://", "ws://"), urlencoding::encode(token));
        let (ws, _) = tokio_tungstenite::connect_async(url).await.map_err(|e| e.to_string())?;
        let mut hub = Hub { ws, next: 1, events: vec![] };
        let hello = hub.next_frame(Duration::from_secs(5)).await.ok_or("pas de hello")?;
        assert_eq!(hello["t"], "hello");
        Ok(hub)
    }
}

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Un client de hub de test : appels, et evenements recus gardes dans l'ordre.
pub struct Hub {
    ws: Socket,
    next: u64,
    pub events: Vec<(String, Value)>,
}

impl Hub {
    async fn next_frame(&mut self, wait: Duration) -> Option<Value> {
        loop {
            let msg = tokio::time::timeout(wait, self.ws.next()).await.ok()??.ok()?;
            if let Message::Text(t) = msg {
                return serde_json::from_str(&t).ok();
            }
            if let Message::Close(_) = msg {
                return None;
            }
        }
    }

    /// Appelle la methode ; Ok(resultat) ou Err(message d'erreur).
    pub async fn invoke(&mut self, method: &str, args: Value) -> Result<Value, String> {
        let id = self.next.to_string();
        self.next += 1;
        self.ws.send(Message::Text(json!({ "t": "invoke", "id": id, "m": method, "a": args }).to_string().into())).await.map_err(|e| e.to_string())?;
        loop {
            let f = self.next_frame(Duration::from_secs(10)).await.ok_or("connexion fermee")?;
            match f["t"].as_str() {
                Some("result") if f["id"] == id => return Ok(f["r"].clone()),
                Some("error") if f["id"] == id => return Err(f["e"].as_str().unwrap_or("").to_string()),
                Some("event") => self.events.push((f["m"].as_str().unwrap_or("").to_string(), f["a"].clone())),
                _ => {}
            }
        }
    }

    /// Le prochain evenement de ce nom (deja recu, ou dans le delai).
    pub async fn wait_event(&mut self, name: &str, wait: Duration) -> Option<Value> {
        if let Some(i) = self.events.iter().position(|(n, _)| n == name) {
            return Some(self.events.remove(i).1);
        }
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let left = deadline.saturating_duration_since(tokio::time::Instant::now());
            if left.is_zero() {
                return None;
            }
            let f = self.next_frame(left).await?;
            if f["t"] == "event" {
                let n = f["m"].as_str().unwrap_or("").to_string();
                if n == name {
                    return Some(f["a"].clone());
                }
                self.events.push((n, f["a"].clone()));
            }
        }
    }

    /// Aucun evenement de ce nom dans le delai.
    pub async fn no_event(&mut self, name: &str, wait: Duration) -> bool {
        self.wait_event(name, wait).await.is_none()
    }

    /// La connexion se ferme (jeton expire).
    pub async fn closed_within(&mut self, wait: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let left = deadline.saturating_duration_since(tokio::time::Instant::now());
            if left.is_zero() {
                return false;
            }
            match tokio::time::timeout(left, self.ws.next()).await {
                Err(_) => return false,
                Ok(None) | Ok(Some(Err(_))) | Ok(Some(Ok(Message::Close(_)))) => return true,
                Ok(Some(Ok(_))) => {}
            }
        }
    }
}

pub fn b64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

pub const SHORT: Duration = Duration::from_millis(400);
pub const LONG: Duration = Duration::from_secs(5);
