// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Pair indexeur (ADR-027, docs/Architecture/indexer-protocol.md) : repartition
// des vaults entre ses instances, client HTTP de son API, et traduction de ses
// reponses en reponses publiques.
//
// Le client ne voit jamais une erreur interne du pair : les erreurs listees
// par le protocole (400, 404, 429, 503) passent telles quelles ; le reste
// (injoignable, delai depasse, 401 d'un jeton mal configure, 500...) devient
// 503 « unavailable » avec Retry-After, et le client bascule sur son index.

use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::domain::{IndexerMode, VaultIndexerSetting};
use crate::error::indexer_error_json;
use crate::options::{IndexerInstance, IndexerOptions};

pub mod codes {
    pub const INVALID_QUERY: &str = "invalid_query";
    pub const INVALID_CURSOR: &str = "invalid_cursor";
    pub const UNKNOWN_CAPABILITY: &str = "unknown_capability";
    pub const NOT_OWNER: &str = "not_owner";
    pub const OVERLOADED: &str = "overloaded";
    pub const UNAVAILABLE: &str = "unavailable";
    pub const RATE_LIMITED: &str = "rate_limited";
    pub const PAYLOAD_TOO_LARGE: &str = "payload_too_large";
    pub const UNKNOWN_INSTANCE: &str = "unknown_instance";
}

// ── Repartition : hachage de rendez-vous ─────────────────────────────────────
//
// Pour chaque instance, h = FNV-1a 64 bits des octets UTF-8 de
// name + "|" + vaultId ; l'instance de plus grand h possede le vault ; a
// egalite, le plus petit nom (ordre ordinal).

pub fn fnv1a64(text: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in text.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

pub fn weight(instance: &str, vault_id: &str) -> u64 {
    fnv1a64(&format!("{instance}|{vault_id}"))
}

pub fn owner_of<'a>(vault_id: &str, instances: &'a [IndexerInstance]) -> Option<&'a IndexerInstance> {
    let mut best: Option<(&IndexerInstance, u64)> = None;
    for i in instances {
        let w = weight(&i.name, vault_id);
        best = match best {
            None => Some((i, w)),
            Some((b, bw)) if w > bw || (w == bw && i.name.as_str() < b.name.as_str()) => Some((i, w)),
            keep => keep,
        };
    }
    best.map(|(i, _)| i)
}

pub fn is_owner(instance: &str, vault_id: &str, instances: &[IndexerInstance]) -> bool {
    owner_of(vault_id, instances).is_some_and(|o| o.name == instance)
}

// ── Reponses publiques ───────────────────────────────────────────────────────

/// Reponse d'une route publique du pair : statut, corps JSON, Retry-After.
#[derive(Debug, Clone)]
pub struct IndexerReply {
    pub status: u16,
    pub json: String,
    pub retry_after: Option<i64>,
}

impl IndexerReply {
    pub fn ok(json: String) -> Self {
        IndexerReply { status: 200, json, retry_after: None }
    }
    pub fn error(status: u16, code: &str, message: &str, retry_after: Option<i64>) -> Self {
        IndexerReply { status, json: indexer_error_json(code, message).to_string(), retry_after }
    }
    /// Pair absent, indisponible ou vault sans pair : 503 + Retry-After.
    pub fn unavailable(message: &str, retry_after: i64) -> Self {
        Self::error(503, codes::UNAVAILABLE, message, Some(retry_after))
    }
    /// Vault servi par un autre pair que le pair gere : 503 avec { mode, url }.
    pub fn not_managed(s: &VaultIndexerSetting, retry_after: i64) -> Self {
        let organization = s.mode == IndexerMode::Organization;
        let mut body = indexer_error_json(
            codes::UNAVAILABLE,
            if organization {
                "Ce vault est servi par le pair indexeur de son organisation."
            } else {
                "Ce vault n'a pas de pair indexeur."
            },
        );
        body["mode"] = json!(s.mode.as_str());
        if organization && let Some(url) = &s.url {
            body["url"] = json!(url);
        }
        // Pas de Retry-After pour un pair d'organisation : reessayer ici ne sert a rien.
        IndexerReply { status: 503, json: body.to_string(), retry_after: if organization { None } else { Some(retry_after) } }
    }
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Answered,
    Unreachable,
    TimedOut,
    TooLarge,
}

#[derive(Debug, Clone)]
pub struct PeerResponse {
    pub outcome: Outcome,
    pub status: u16,
    pub body: Option<String>,
    pub retry_after: Option<Duration>,
}

impl PeerResponse {
    pub fn failed(outcome: Outcome) -> Self {
        PeerResponse { outcome, status: 0, body: None, retry_after: None }
    }
    pub fn is_success(&self) -> bool {
        self.outcome == Outcome::Answered && (200..300).contains(&self.status)
    }
}

pub fn parse_object(body: Option<&str>) -> Option<serde_json::Map<String, Value>> {
    match serde_json::from_str::<Value>(body?) {
        Ok(Value::Object(m)) => Some(m),
        _ => None,
    }
}

fn error_of(body: Option<&str>) -> (Option<String>, Option<String>) {
    let Some(obj) = parse_object(body) else { return (None, None) };
    match obj.get("error") {
        Some(Value::Object(e)) => (
            e.get("code").and_then(Value::as_str).map(str::to_string),
            e.get("message").and_then(Value::as_str).map(str::to_string),
        ),
        _ => (None, None),
    }
}

pub fn is_not_owner(r: &PeerResponse) -> bool {
    r.outcome == Outcome::Answered && r.status == 409 && error_of(r.body.as_deref()).0.as_deref() == Some(codes::NOT_OWNER)
}

/// Corps de POST /v1/vaults/{id}/call. L'appelant vient du jeton, jamais du client.
/// Corps d'un appel au pair. `access` : les regles d'acces de l'appelant dans
/// ce vault (access::peer_rules), que le pair applique a ses resultats.
pub fn call_body(capability: &str, method: &str, params: &Value, caller: &str, access: &Value) -> Vec<u8> {
    json!({ "capability": capability, "method": method, "params": params, "caller": { "userId": caller, "access": access } })
        .to_string()
        .into_bytes()
}

/// Reponse publique pour une reponse du pair. `result_only` : le champ « result ».
pub fn to_reply(r: &PeerResponse, opts: &IndexerOptions, result_only: bool) -> IndexerReply {
    let ra = opts.retry_after_seconds;
    match r.outcome {
        Outcome::Unreachable => return IndexerReply::unavailable("Le pair indexeur est injoignable.", ra),
        Outcome::TimedOut => return IndexerReply::unavailable("Le pair indexeur n'a pas repondu a temps.", ra),
        Outcome::TooLarge => {
            tracing::warn!(max = opts.max_response_bytes, "Pair indexeur : reponse trop grande");
            return IndexerReply::unavailable("Reponse du pair indexeur trop grande.", ra);
        }
        Outcome::Answered => {}
    }
    if r.is_success() {
        let parsed: Option<Value> = r.body.as_deref().and_then(|b| serde_json::from_str(b).ok());
        let out = if result_only {
            match parsed {
                Some(Value::Object(mut m)) => m.remove("result").map(|v| v.to_string()),
                _ => None,
            }
        } else {
            parsed.map(|_| r.body.clone().unwrap_or_default())
        };
        return match out {
            Some(json) => IndexerReply::ok(json),
            None => {
                tracing::warn!("Pair indexeur : reponse illisible");
                IndexerReply::unavailable("Reponse du pair indexeur illisible.", ra)
            }
        };
    }
    let retry = r.retry_after.map(|d| (d.as_secs_f64().ceil() as i64).max(1)).unwrap_or(ra);
    match r.status {
        400 | 404 => pass_through(r, None),
        429 | 503 => pass_through(r, Some(retry)),
        401 | 403 => {
            tracing::error!(status = r.status, "Pair indexeur : jeton de service refuse. Verifier Indexer:ServiceToken et SAVOIRE_INDEXER_TOKEN, ou Indexer:Oidc.");
            IndexerReply::unavailable("Le pair indexeur est indisponible.", ra)
        }
        409 => IndexerReply::unavailable("Le routage du pair indexeur change, reessayer.", retry),
        s => {
            tracing::warn!(status = s, "Pair indexeur : statut inattendu");
            IndexerReply::unavailable("Le pair indexeur est indisponible.", ra)
        }
    }
}

/// Erreur du pair rendue telle quelle, mais reecrite : seuls code et message passent.
fn pass_through(r: &PeerResponse, retry_after: Option<i64>) -> IndexerReply {
    let (code, message) = error_of(r.body.as_deref());
    let fallback = match r.status {
        404 => codes::UNKNOWN_CAPABILITY,
        429 => codes::OVERLOADED,
        503 => codes::UNAVAILABLE,
        _ => codes::INVALID_QUERY,
    };
    IndexerReply::error(r.status, code.as_deref().unwrap_or(fallback), message.as_deref().unwrap_or(""), retry_after)
}

// ── Client HTTP du pair ──────────────────────────────────────────────────────

/// Jeton presente par l'API au pair (ADR-028) : « client credentials » du
/// compte de service chez le fournisseur (garde jusqu'a une minute avant son
/// expiration, une seule demande a la fois), sinon le jeton partage.
#[derive(Default)]
pub struct ServiceTokens {
    current: Mutex<Option<(String, Instant, String)>>,
}

impl ServiceTokens {
    pub async fn get(&self, http: &reqwest::Client, opts: &IndexerOptions) -> Result<Option<String>, String> {
        if !opts.oidc.configured() {
            return Ok(opts.service_token.clone());
        }
        let o = &opts.oidc;
        let key = format!("{}|{}", o.token_endpoint.as_deref().unwrap_or(""), o.client_id.as_deref().unwrap_or(""));
        let mut cur = self.current.lock().await;
        if let Some((token, renew_at, k)) = cur.as_ref()
            && *k == key
            && Instant::now() < *renew_at
        {
            return Ok(Some(token.clone()));
        }
        let (token, lifetime) = client_credentials(http, o.token_endpoint.as_deref().unwrap_or(""), o.client_id.as_deref().unwrap_or(""), o.client_secret.as_deref().unwrap_or(""), o.scope.as_deref()).await?;
        let renew = Instant::now() + Duration::from_secs((lifetime.max(60) - 60) as u64);
        *cur = Some((token.clone(), renew, key));
        Ok(Some(token))
    }

    /// Jeton refuse par le pair (401) : le suivant sera neuf.
    pub async fn invalidate(&self) {
        *self.current.lock().await = None;
    }
}

/// Jeton « client credentials » : (jeton, duree de vie en secondes).
pub async fn client_credentials(
    http: &reqwest::Client,
    endpoint: &str,
    client_id: &str,
    secret: &str,
    scope: Option<&str>,
) -> Result<(String, i64), String> {
    let mut form = vec![("grant_type", "client_credentials".to_string())];
    if let Some(s) = scope.filter(|s| !s.trim().is_empty()) {
        form.push(("scope", s.to_string()));
    }
    let basic = {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(format!(
            "{}:{}",
            urlencoding::encode(client_id),
            urlencoding::encode(secret)
        ))
    };
    let res = http
        .post(endpoint)
        .header("Authorization", format!("Basic {basic}"))
        .form(&form)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let body = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Fournisseur d'identite : jeton de service refuse ({}).", status.as_u16()));
    }
    let v: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let token = v.get("access_token").and_then(Value::as_str).ok_or("Fournisseur d'identite : reponse sans jeton.")?;
    let lifetime = v.get("expires_in").and_then(Value::as_i64).unwrap_or(300);
    Ok((token.to_string(), lifetime))
}

pub struct PeerClient {
    pub http: reqwest::Client,
    pub tokens: ServiceTokens,
}

impl PeerClient {
    pub fn new(http: reqwest::Client) -> Self {
        PeerClient { http, tokens: ServiceTokens::default() }
    }

    pub async fn call(&self, opts: &IndexerOptions, i: &IndexerInstance, vault_id: &str, body: Vec<u8>) -> PeerResponse {
        let path = format!("v1/vaults/{}/call", urlencoding::encode(vault_id));
        self.send(opts, i, reqwest::Method::POST, &path, Some(body)).await
    }

    pub async fn search(&self, opts: &IndexerOptions, i: &IndexerInstance, body: Vec<u8>) -> PeerResponse {
        self.send(opts, i, reqwest::Method::POST, "v1/search", Some(body)).await
    }

    pub async fn status(&self, opts: &IndexerOptions, i: &IndexerInstance, vault_id: &str) -> PeerResponse {
        let path = format!("v1/vaults/{}/status", urlencoding::encode(vault_id));
        self.send(opts, i, reqwest::Method::GET, &path, None).await
    }

    async fn send(&self, opts: &IndexerOptions, i: &IndexerInstance, method: reqwest::Method, path: &str, body: Option<Vec<u8>>) -> PeerResponse {
        let token = match self.tokens.get(&self.http, opts).await {
            Ok(t) => t,
            Err(e) => {
                tracing::error!(error = %e, "Pair indexeur : pas de jeton de service");
                return PeerResponse::failed(Outcome::Unreachable);
            }
        };
        let base = if i.url.ends_with('/') { i.url.clone() } else { format!("{}/", i.url) };
        let Ok(url) = url::Url::parse(&base).and_then(|b| b.join(path)) else {
            return PeerResponse::failed(Outcome::Unreachable);
        };
        let mut req = self.http.request(method, url).header("Accept", "application/json");
        if let Some(t) = token {
            req = req.bearer_auth(t);
        }
        if let Some(b) = body {
            req = req.header("Content-Type", "application/json; charset=utf-8").body(b);
        }
        let timeout = Duration::from_millis(opts.timeout_ms.max(1) as u64);
        let max = opts.max_response_bytes.max(0) as usize;
        let fut = async {
            let res = req.send().await?;
            let status = res.status().as_u16();
            let retry_after = res
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.trim().parse::<u64>().ok())
                .map(Duration::from_secs);
            if res.content_length().is_some_and(|l| l as usize > max) {
                return Ok::<_, reqwest::Error>((status, None, retry_after, true));
            }
            let mut res = res;
            let mut buf: Vec<u8> = vec![];
            while let Some(chunk) = res.chunk().await? {
                if buf.len() + chunk.len() > max {
                    return Ok((status, None, retry_after, true));
                }
                buf.extend_from_slice(&chunk);
            }
            Ok((status, Some(String::from_utf8_lossy(&buf).into_owned()), retry_after, false))
        };
        match tokio::time::timeout(timeout, fut).await {
            Err(_) => {
                tracing::warn!(instance = %i.name, path, "Pair indexeur : pas de reponse dans le delai");
                PeerResponse::failed(Outcome::TimedOut)
            }
            Ok(Err(e)) => {
                tracing::warn!(instance = %i.name, path, error = %e, "Pair indexeur injoignable");
                PeerResponse::failed(Outcome::Unreachable)
            }
            Ok(Ok((status, body, retry_after, too_large))) => {
                if status == 401 {
                    self.tokens.invalidate().await;
                }
                if too_large {
                    return PeerResponse::failed(Outcome::TooLarge);
                }
                PeerResponse { outcome: Outcome::Answered, status, body, retry_after }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inst(names: &[&str]) -> Vec<IndexerInstance> {
        names.iter().map(|n| IndexerInstance { name: n.to_string(), url: format!("http://{n}") }).collect()
    }

    #[test]
    fn fnv_vectors() {
        // Vecteurs FNV-1a 64 bits de reference.
        assert_eq!(fnv1a64(""), 0xcbf29ce484222325);
        assert_eq!(fnv1a64("a"), 0xaf63dc4c8601ec8c);
        assert_eq!(fnv1a64("foobar"), 0x85944171f73967e8);
    }

    #[test]
    fn routing_is_stable() {
        let i = inst(&["a", "b", "c"]);
        let o = owner_of("vault-1", &i).unwrap().name.clone();
        assert_eq!(owner_of("vault-1", &i).unwrap().name, o);
        assert!(is_owner(&o, "vault-1", &i));
        assert!(owner_of("v", &[]).is_none());
        let single = inst(&["only"]);
        assert_eq!(owner_of("anything", &single).unwrap().name, "only");
    }

    #[test]
    fn reply_translation() {
        let opts = IndexerOptions::from(&crate::config::Settings::default());
        let ok = PeerResponse { outcome: Outcome::Answered, status: 200, body: Some(r#"{"result":{"x":1}}"#.into()), retry_after: None };
        assert_eq!(to_reply(&ok, &opts, true).json, r#"{"x":1}"#);
        let bad = PeerResponse { outcome: Outcome::Answered, status: 500, body: None, retry_after: None };
        let r = to_reply(&bad, &opts, true);
        assert_eq!((r.status, r.retry_after), (503, Some(5)));
        let q = PeerResponse { outcome: Outcome::Answered, status: 400, body: Some(r#"{"error":{"code":"too_complex","message":"m","secret":1}}"#.into()), retry_after: None };
        let r = to_reply(&q, &opts, true);
        assert_eq!(r.status, 400);
        assert_eq!(r.json, r#"{"error":{"code":"too_complex","message":"m"}}"#);
        let no = PeerResponse { outcome: Outcome::Answered, status: 409, body: Some(r#"{"error":{"code":"not_owner"}}"#.into()), retry_after: None };
        assert!(is_not_owner(&no));
    }
}
