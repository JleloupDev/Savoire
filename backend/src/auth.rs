// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Authentification. Deux sortes de jetons, un seul point d'entree (Bearer) :
//  - « oidc » : les comptes, jetons du fournisseur d'identite (ADR-028),
//    verifies par ses cles publiees (JWKS) ;
//  - « savoire » : jetons signes par Savoire (Jwt:Secret, HS256), pour les
//    liens de partage et les vues integrees, sans compte.
// Le choix se fait sur l'emetteur du jeton (lu sans verification : la
// verification est faite ensuite par le schema choisi).
// Un troisieme schema, les jetons personnels « svp_... », ne sert que sur
// l'API ouverte (/api/open/v1, /api/mcp).
//
// Temps reel (WebSocket) : le jeton arrive dans la query string (access_token).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::{FromRef, FromRequestParts};
use axum::http::request::Parts;
use base64::Engine;
use dashmap::DashMap;
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::sync::RwLock;

use crate::db::{repos, users};
use crate::domain::{AppUser, ShareLink, Ts, now};
use crate::error::{AppError, AppResult};
use crate::options::{IndexerOptions, JwtOptions, OidcOptions, PEER_CLAIM};
use crate::state::AppState;

/// Qui appelle : ce que les handlers et les hubs savent de la personne.
#[derive(Clone, Debug, Default)]
pub struct Principal {
    /// Le sujet : un compte, « share:{lien} » ou « view:{vault}:{doc}:{droit} ».
    pub sub: String,
    pub is_admin: bool,
    pub display_name: Option<String>,
    pub email: Option<String>,
    /// Vue integree : la personne derriere la vue (presence, auteur).
    pub view_user_id: Option<String>,
    /// Compte de service reconnu (« indexer »).
    pub service: Option<String>,
    /// Expiration du jeton (une connexion temps reel ne lui survit pas).
    pub expires_at: Option<Ts>,
    /// Jeton personnel : ses vaults (None : tous ceux de la personne).
    pub token_vaults: Option<Vec<String>>,
    /// Jeton personnel rattache a un agent (ADR-033) : l'IA externe agit sous son nom.
    pub token_agent: Option<String>,
}

// ── Jetons signes par Savoire ────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug, Default)]
struct LocalClaims {
    sub: String,
    #[serde(default)]
    jti: String,
    iss: String,
    aud: String,
    exp: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    share_link_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    share_resource_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    share_resource_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    share_permission: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    view_vault_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    view_doc_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    view_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    view_permission: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    view_user_id: Option<String>,
}

/// Contenu d'un jeton de vue (bootstrap d'une iframe).
#[derive(Clone, Debug)]
pub struct ViewGrant {
    pub vault_id: String,
    pub doc_id: String,
    pub path: String,
    pub permission: String,
    pub user_id: Option<String>,
    pub expires_at: Ts,
}

fn secret(jwt: &JwtOptions) -> AppResult<Vec<u8>> {
    jwt.secret.as_ref().map(|s| s.as_bytes().to_vec()).ok_or_else(|| AppError::internal("Jwt:Secret manquant."))
}

fn sign(jwt: &JwtOptions, claims: &LocalClaims) -> AppResult<String> {
    jsonwebtoken::encode(&Header::new(Algorithm::HS256), claims, &EncodingKey::from_secret(&secret(jwt)?).map_err(AppError::internal)?)
        .map_err(AppError::internal)
}

fn local_validation(jwt: &JwtOptions, leeway: u64) -> Validation {
    let mut v = Validation::new(Algorithm::HS256);
    v.set_issuer(&[&jwt.issuer]);
    v.set_audience(&[&jwt.audience]);
    v.leeway = leeway;
    v.validate_exp = true;
    v
}

pub fn share_link_token(jwt: &JwtOptions, link: &ShareLink) -> AppResult<String> {
    let expires = link.expires_at.unwrap_or_else(|| now() + chrono::Duration::hours(8));
    sign(
        jwt,
        &LocalClaims {
            sub: format!("share:{}", link.id),
            jti: uuid::Uuid::new_v4().to_string(),
            iss: jwt.issuer.clone(),
            aud: jwt.audience.clone(),
            exp: expires.timestamp(),
            share_link_id: Some(link.id.clone()),
            share_resource_type: Some(link.resource_type.as_str().into()),
            share_resource_id: Some(link.resource_id.clone()),
            share_permission: Some(link.permission.as_str().into()),
            ..Default::default()
        },
    )
}

fn view_claims(jwt: &JwtOptions, sub: String, g: &ViewGrant, exp: Ts) -> LocalClaims {
    LocalClaims {
        sub,
        jti: uuid::Uuid::new_v4().to_string(),
        iss: jwt.issuer.clone(),
        aud: jwt.audience.clone(),
        exp: exp.timestamp(),
        view_vault_id: Some(g.vault_id.clone()),
        view_doc_id: Some(g.doc_id.clone()),
        view_path: Some(g.path.clone()),
        view_permission: Some(g.permission.clone()),
        view_user_id: g.user_id.clone().filter(|u| !u.trim().is_empty()),
        ..Default::default()
    }
}

pub fn view_grant_token(jwt: &JwtOptions, g: &ViewGrant) -> AppResult<String> {
    sign(jwt, &view_claims(jwt, "view-grant".into(), g, g.expires_at))
}

pub fn view_access_token(jwt: &JwtOptions, g: &ViewGrant) -> AppResult<String> {
    let sub = format!("view:{}:{}:{}", g.vault_id, g.doc_id, g.permission);
    sign(jwt, &view_claims(jwt, sub, g, now() + chrono::Duration::hours(8)))
}

/// Lit un jeton de vue. Refus : AccessDenied (« expiré » ou « invalide »).
pub fn read_view_grant(jwt: &JwtOptions, token: &str) -> AppResult<ViewGrant> {
    let data = jsonwebtoken::decode::<LocalClaims>(token, &DecodingKey::from_secret(&secret(jwt)?).map_err(AppError::internal)?, &local_validation(jwt, 15))
        .map_err(|e| match e.kind() {
            jsonwebtoken::errors::ErrorKind::ExpiredSignature => AppError::denied("View grant expiré."),
            _ => AppError::denied("View grant invalide."),
        })?;
    let c = data.claims;
    if c.sub != "view-grant" && !c.sub.starts_with("view:") {
        return Err(AppError::denied("View grant invalide."));
    }
    Ok(ViewGrant {
        vault_id: c.view_vault_id.ok_or_else(|| AppError::denied("View grant invalide (vault)."))?,
        doc_id: c.view_doc_id.ok_or_else(|| AppError::denied("View grant invalide (document)."))?,
        path: c.view_path.ok_or_else(|| AppError::denied("View grant invalide (path)."))?,
        permission: c.view_permission.ok_or_else(|| AppError::denied("View grant invalide (permission)."))?,
        user_id: c.view_user_id,
        expires_at: chrono::DateTime::from_timestamp(c.exp, 0).unwrap_or_else(now),
    })
}

// ── Jetons personnels (API ouverte) ──────────────────────────────────────────

pub mod access_token {
    use super::*;

    pub const PREFIX: &str = "svp_";
    pub const READ_SCOPE: &str = "read";
    pub const MAX_ACTIVE_PER_USER: i64 = 50;
    pub const MAX_VAULTS: usize = 100;
    pub const MAX_NAME_CHARS: usize = 100;
    pub const MAX_DAYS: i64 = 3650;

    pub fn generate() -> String {
        format!("{PREFIX}{}", crate::domain::random_token())
    }
    /// Empreinte gardee en base (SHA-256, hexadecimal).
    pub fn hash(token: &str) -> String {
        hex::encode(Sha256::digest(token.as_bytes()))
    }
    pub fn looks_like(token: &str) -> bool {
        token.len() > 20 && token.len() < 200 && token.starts_with(PREFIX)
    }
    /// Le debut, pour reconnaitre le jeton dans la liste.
    pub fn display(token: &str) -> String {
        token.chars().take(PREFIX.len() + 6).collect()
    }
}

// ── Fournisseur d'identite ───────────────────────────────────────────────────

#[derive(Clone)]
struct OidcMeta {
    issuer: String,
    jwks: jsonwebtoken::jwk::JwkSet,
    userinfo: Option<String>,
    fetched: Instant,
    authority: String,
}

/// Ce que l'API sait d'un compte pendant une requete.
#[derive(Clone, Debug)]
pub struct Account {
    pub id: String,
    pub display_name: String,
    pub email: Option<String>,
    pub is_admin: bool,
}

#[derive(Clone, Debug, Default)]
pub struct Profile {
    pub email: Option<String>,
    pub email_verified: bool,
    pub name: Option<String>,
    pub preferred_username: Option<String>,
}

pub struct Authenticator {
    meta: RwLock<Option<OidcMeta>>,
    /// Etat des comptes, une minute : un blocage prend effet en une minute au plus.
    accounts: DashMap<String, (Option<Account>, Instant)>,
    /// Comptes supprimes : leur jeton, encore valide chez l'IdP, ne les recree pas.
    deleted: DashMap<String, Instant>,
}

const ACCOUNT_TTL: Duration = Duration::from_secs(60);
const DELETED_TTL: Duration = Duration::from_secs(24 * 3600);
const JWKS_TTL: Duration = Duration::from_secs(3600);

impl Default for Authenticator {
    fn default() -> Self {
        Self::new()
    }
}

impl Authenticator {
    pub fn new() -> Self {
        Authenticator { meta: RwLock::new(None), accounts: DashMap::new(), deleted: DashMap::new() }
    }

    /// Le compte doit etre relu (blocage, droits).
    pub fn forget(&self, user_id: &str) {
        self.accounts.remove(user_id);
    }

    pub fn mark_deleted(&self, user_id: &str) {
        self.accounts.remove(user_id);
        self.deleted.insert(user_id.to_string(), Instant::now());
    }

    async fn oidc_meta(&self, http: &reqwest::Client, oidc: &OidcOptions, force: bool) -> AppResult<OidcMeta> {
        let authority = oidc.authority.clone().unwrap_or_default();
        if !force
            && let Some(m) = self.meta.read().await.as_ref()
            && m.authority == authority
            && m.fetched.elapsed() < JWKS_TTL
        {
            return Ok(m.clone());
        }
        let url = format!("{authority}/.well-known/openid-configuration");
        if oidc.require_https_metadata && !url.starts_with("https://") {
            return Err(AppError::internal("Auth:Oidc:Authority doit etre en https (RequireHttpsMetadata)."));
        }
        let doc: Value = http.get(&url).timeout(Duration::from_secs(10)).send().await.map_err(AppError::internal)?
            .error_for_status().map_err(AppError::internal)?
            .json().await.map_err(AppError::internal)?;
        let jwks_uri = doc.get("jwks_uri").and_then(Value::as_str).ok_or_else(|| AppError::internal("jwks_uri absent"))?;
        let jwks: jsonwebtoken::jwk::JwkSet = http.get(jwks_uri).timeout(Duration::from_secs(10)).send().await.map_err(AppError::internal)?
            .json().await.map_err(AppError::internal)?;
        let meta = OidcMeta {
            issuer: doc.get("issuer").and_then(Value::as_str).unwrap_or(&authority).to_string(),
            jwks,
            userinfo: doc.get("userinfo_endpoint").and_then(Value::as_str).map(str::to_string),
            fetched: Instant::now(),
            authority,
        };
        *self.meta.write().await = Some(meta.clone());
        Ok(meta)
    }

    /// Verifie un jeton (savoire ou oidc) et rend l'appelant. None : refuse.
    pub async fn authenticate(&self, st: &AppState, token: &str) -> Option<Principal> {
        let settings = st.settings();
        let jwt = JwtOptions::from(&settings);
        if issuer_of(token).as_deref() == Some(jwt.issuer.as_str()) {
            return verify_local(&jwt, token);
        }
        let oidc = OidcOptions::from(&settings);
        if !oidc.enabled() {
            return None;
        }
        match self.verify_oidc(st, &oidc, &IndexerOptions::from(&settings), token, &settings.str_list("Auth:AdminEmails")).await {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!(error = %e, "Jeton du fournisseur d'identite refuse");
                None
            }
        }
    }

    async fn verify_oidc(
        &self,
        st: &AppState,
        oidc: &OidcOptions,
        indexer: &IndexerOptions,
        token: &str,
        admin_emails: &[String],
    ) -> AppResult<Option<Principal>> {
        let header = jsonwebtoken::decode_header(token).map_err(AppError::internal)?;
        let mut meta = self.oidc_meta(&st.http, oidc, false).await?;
        let find = |m: &OidcMeta| match &header.kid {
            Some(kid) => m.jwks.find(kid).cloned(),
            None => m.jwks.keys.first().cloned(),
        };
        let jwk = match find(&meta) {
            Some(k) => k,
            None => {
                // Cles tournees chez l'IdP : on relit.
                meta = self.oidc_meta(&st.http, oidc, true).await?;
                find(&meta).ok_or_else(|| AppError::internal("cle de signature inconnue"))?
            }
        };
        let key = DecodingKey::from_jwk(&jwk).map_err(AppError::internal)?;
        let mut v = Validation::new(header.alg);
        v.set_issuer(&[&meta.issuer]);
        v.set_audience(&[oidc.audience.as_deref().unwrap_or_default()]);
        v.leeway = 30;
        let data = jsonwebtoken::decode::<HashMap<String, Value>>(token, &key, &v).map_err(AppError::internal)?;
        let c = data.claims;
        let s = |k: &str| c.get(k).and_then(Value::as_str).map(str::to_string);
        let Some(sub) = s("sub").filter(|x| !x.is_empty()) else { return Ok(None) };
        let exp = c.get("exp").and_then(Value::as_i64).and_then(|e| chrono::DateTime::from_timestamp(e, 0));
        // Comptes de service (client credentials) : pas de compte Savoire.
        if indexer.oidc.peer_subject.as_deref().is_some_and(|p| !p.is_empty() && p == sub) {
            return Ok(Some(Principal { sub, service: Some("indexer".into()), expires_at: exp, ..Default::default() }));
        }
        let profile = Profile {
            email: s("email"),
            email_verified: matches!(c.get("email_verified"), Some(Value::Bool(true))) || s("email_verified").as_deref() == Some("true"),
            name: s("name"),
            preferred_username: s("preferred_username"),
        };
        let account = match self.resolve(st, &sub, profile, meta.userinfo.as_deref(), token, admin_emails).await {
            Ok(a) => a,
            Err(e) => {
                tracing::error!(subject = %sub, error = %e, "Compte : resolution impossible.");
                return Ok(None);
            }
        };
        let Some(account) = account else { return Ok(None) };
        Ok(Some(Principal {
            sub,
            is_admin: account.is_admin,
            display_name: Some(account.display_name),
            email: s("email").or(account.email),
            expires_at: exp,
            ..Default::default()
        }))
    }

    /// Le compte du sujet, cree a la premiere connexion ; None s'il est bloque.
    async fn resolve(
        &self,
        st: &AppState,
        subject: &str,
        mut profile: Profile,
        userinfo: Option<&str>,
        token: &str,
        admin_emails: &[String],
    ) -> AppResult<Option<Account>> {
        if let Some(e) = self.accounts.get(subject)
            && e.1.elapsed() < ACCOUNT_TTL
        {
            return Ok(e.0.clone());
        }
        if let Some(d) = self.deleted.get(subject) {
            if d.elapsed() < DELETED_TTL {
                return Ok(None);
            }
            drop(d);
            self.deleted.remove(subject);
        }
        let mut c = st.db.acquire().await?;
        let user = match users::by_id(&mut c, subject).await? {
            None => {
                if profile.email.is_none()
                    && let Some(p) = fetch_userinfo(&st.http, userinfo, token).await
                {
                    profile = p;
                }
                create_account(&mut c, subject, &profile, admin_emails).await?
            }
            Some(mut user) => {
                // Compte cree avant que l'adresse soit verifiee : on la reprend des qu'elle l'est.
                let fresh = if user.email.is_none() {
                    if profile.email.is_some() && profile.email_verified {
                        Some(profile.clone())
                    } else {
                        fetch_userinfo(&st.http, userinfo, token).await
                    }
                } else {
                    None
                };
                refresh_account(&mut c, &mut user, fresh, admin_emails).await?;
                user
            }
        };
        let account = if users::is_locked(&user) {
            None
        } else {
            Some(Account { id: user.id.clone(), display_name: user.display_name.clone(), email: user.email.clone(), is_admin: user.is_admin })
        };
        self.accounts.insert(subject.to_string(), (account.clone(), Instant::now()));
        Ok(account)
    }
}

fn is_admin_email(admin_emails: &[String], email: Option<&str>, verified: bool) -> bool {
    verified && email.is_some_and(|e| admin_emails.iter().any(|a| a.trim().eq_ignore_ascii_case(e)))
}

fn first_non_empty(values: &[Option<&str>]) -> Option<String> {
    values.iter().flatten().find(|v| !v.trim().is_empty()).map(|v| v.trim().to_string())
}

async fn create_account(c: &mut sqlx::PgConnection, subject: &str, p: &Profile, admin_emails: &[String]) -> AppResult<AppUser> {
    // Seule une adresse verifiee par l'IdP est gardee : on invite par adresse.
    let mut email = if !p.email_verified { None } else { p.email.as_deref().map(str::trim).filter(|e| !e.is_empty()).map(str::to_string) };
    if let Some(e) = &email
        && users::by_email(c, e).await?.is_some()
    {
        tracing::warn!(subject, "Compte : adresse deja utilisee par un autre compte, non reprise.");
        email = None;
    }
    let user = AppUser {
        id: subject.to_string(),
        display_name: first_non_empty(&[p.name.as_deref(), p.preferred_username.as_deref(), email.as_deref()]).unwrap_or_else(|| "Utilisateur".into()),
        email_confirmed: email.is_some(),
        is_admin: is_admin_email(admin_emails, email.as_deref(), email.is_some()),
        email,
        created_at: now(),
        last_login_at: Some(now()),
        lockout_end: None,
        private_key_hex: None,
    };
    if users::create(c, &user).await? {
        tracing::info!(subject, "Compte cree (premiere connexion).");
        return Ok(user);
    }
    // Deux premieres requetes en meme temps (page et WebSocket) : l'autre l'a cree.
    users::by_id(c, subject).await?.ok_or_else(|| AppError::internal("Compte : creation impossible."))
}

/// Adresse verifiee depuis, administrateur ajoute depuis, derniere connexion (au plus une fois l'heure).
async fn refresh_account(c: &mut sqlx::PgConnection, u: &mut AppUser, fresh: Option<Profile>, admin_emails: &[String]) -> AppResult<()> {
    let mut changed = false;
    if u.email.is_none()
        && let Some(f) = fresh
        && f.email_verified
        && let Some(e) = f.email.as_deref().map(str::trim).filter(|e| !e.is_empty())
        && users::by_email(c, e).await?.is_none()
    {
        u.email = Some(e.to_string());
        u.email_confirmed = true;
        changed = true;
    }
    if !u.is_admin && is_admin_email(admin_emails, u.email.as_deref(), u.email_confirmed) {
        u.is_admin = true;
        changed = true;
    }
    if u.last_login_at.is_none_or(|t| t < now() - chrono::Duration::hours(1)) {
        u.last_login_at = Some(now());
        changed = true;
    }
    if changed {
        users::update_profile(c, u).await?;
    }
    Ok(())
}

/// Profil lu chez l'IdP (userinfo) avec le jeton de la personne.
async fn fetch_userinfo(http: &reqwest::Client, endpoint: Option<&str>, token: &str) -> Option<Profile> {
    let endpoint = endpoint?;
    let res = http.get(endpoint).bearer_auth(token).timeout(Duration::from_secs(10)).send().await.ok()?;
    if !res.status().is_success() {
        tracing::warn!(status = res.status().as_u16(), "userinfo");
        return None;
    }
    let v: Value = res.json().await.ok()?;
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    Some(Profile {
        email: s("email"),
        email_verified: v.get("email_verified") == Some(&Value::Bool(true)),
        name: s("name"),
        preferred_username: s("preferred_username"),
    })
}

/// Emetteur d'un JWT, lu sans verification.
pub fn issuer_of(token: &str) -> Option<String> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    let v: Value = serde_json::from_slice(&bytes).ok()?;
    v.get("iss").and_then(Value::as_str).map(str::to_string)
}

fn verify_local(jwt: &JwtOptions, token: &str) -> Option<Principal> {
    let key = DecodingKey::from_secret(&secret(jwt).ok()?).ok()?;
    let data = jsonwebtoken::decode::<LocalClaims>(token, &key, &local_validation(jwt, 30)).ok()?;
    let c = data.claims;
    Some(Principal {
        sub: c.sub,
        view_user_id: c.view_user_id,
        expires_at: chrono::DateTime::from_timestamp(c.exp, 0),
        ..Default::default()
    })
}

// ── Jetons personnels : verification ─────────────────────────────────────────

const TOUCH_EVERY: chrono::Duration = chrono::Duration::minutes(5);

/// Un jeton personnel valide ; None sinon (inconnu, revoque, expire, compte indisponible).
pub async fn authenticate_access_token(st: &AppState, token: &str) -> AppResult<Option<Principal>> {
    if !access_token::looks_like(token) {
        return Ok(None);
    }
    let mut c = st.db.acquire().await?;
    let Some(t) = repos::token_by_hash(&mut c, &access_token::hash(token)).await? else { return Ok(None) };
    let at = now();
    if t.revoked_at.is_some() || t.expires_at.is_some_and(|e| e <= at) {
        return Ok(None);
    }
    let Some(user) = users::by_id(&mut c, &t.user_id).await? else { return Ok(None) };
    if users::is_locked(&user) {
        return Ok(None);
    }
    if t.last_used_at.is_none_or(|l| l < at - TOUCH_EVERY) {
        repos::token_touch(&mut c, &t.id, at).await?;
    }
    Ok(Some(Principal {
        sub: t.user_id,
        display_name: Some(user.display_name),
        token_vaults: t.vault_ids,
        token_agent: t.agent_id,
        ..Default::default()
    }))
}

// ── Extracteurs ──────────────────────────────────────────────────────────────

pub fn bearer(parts: &Parts) -> Option<String> {
    let h = parts.headers.get(axum::http::header::AUTHORIZATION)?.to_str().ok()?;
    if h.len() > 7 && h[..7].eq_ignore_ascii_case("bearer ") { Some(h[7..].trim().to_string()) } else { None }
}

/// Jeton d'une requete : en-tete Authorization, ou access_token pour les WebSockets (/hubs).
pub fn request_token(parts: &Parts) -> Option<String> {
    if let Some(t) = bearer(parts) {
        return Some(t);
    }
    if parts.uri.path().starts_with("/hubs") {
        return parts.uri.query().and_then(|q| {
            url::form_urlencoded::parse(q.as_bytes()).find(|(k, _)| k == "access_token").map(|(_, v)| v.into_owned())
        });
    }
    None
}

/// Appelant optionnel (routes sans compte obligatoire). Les jetons
/// personnels n'y sont pas acceptes.
pub struct MaybeAuth(pub Option<Principal>);

/// Compte (ou lien) connecte, obligatoire : 401 sinon.
pub struct Auth(pub Principal);

/// Administrateur de l'instance : 401 sans compte, 403 sinon.
pub struct AdminAuth(pub Principal);

/// Jeton personnel (API ouverte) : 401 sinon.
pub struct OpenAuth(pub Principal);

async fn principal_of(parts: &Parts, st: &AppState) -> Option<Principal> {
    if let Some(p) = parts.extensions.get::<Arc<Option<Principal>>>() {
        return (**p).clone();
    }
    let token = request_token(parts)?;
    // Un jeton personnel n'ouvre jamais les routes de l'application.
    if access_token::looks_like(&token) {
        return None;
    }
    st.auth.authenticate(st, &token).await
}

impl<S> FromRequestParts<S> for MaybeAuth
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = AppError;
    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, AppError> {
        let st = AppState::from_ref(state);
        let p = principal_of(parts, &st).await;
        parts.extensions.insert(Arc::new(p.clone()));
        Ok(MaybeAuth(p))
    }
}

impl<S> FromRequestParts<S> for Auth
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = AppError;
    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, AppError> {
        match MaybeAuth::from_request_parts(parts, state).await?.0 {
            Some(p) => Ok(Auth(p)),
            None => Err(AppError::Unauthorized("User not authenticated.".into())),
        }
    }
}

impl<S> FromRequestParts<S> for AdminAuth
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = AppError;
    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, AppError> {
        let Auth(p) = Auth::from_request_parts(parts, state).await?;
        if !p.is_admin {
            return Err(AppError::denied("Réservé aux administrateurs."));
        }
        Ok(AdminAuth(p))
    }
}

impl<S> FromRequestParts<S> for OpenAuth
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = axum::response::Response;
    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        use axum::response::IntoResponse;
        let st = AppState::from_ref(state);
        let refuse = || {
            let mut r = axum::http::StatusCode::UNAUTHORIZED.into_response();
            r.headers_mut().insert(
                axum::http::header::WWW_AUTHENTICATE,
                axum::http::HeaderValue::from_static("Bearer realm=\"savoire\", error=\"invalid_token\""),
            );
            r
        };
        let Some(token) = bearer(parts) else { return Err(refuse()) };
        match authenticate_access_token(&st, &token).await {
            Ok(Some(p)) => Ok(OpenAuth(p)),
            Ok(None) => Err(refuse()),
            Err(e) => Err(e.into_response()),
        }
    }
}

/// Le pair indexeur (API interne) : son compte de service chez l'IdP, ou le
/// jeton partage Indexer:ServiceToken (compare en temps constant sur les
/// empreintes). Ni l'un ni l'autre configure : 404.
pub async fn indexer_peer_allowed(st: &AppState, parts: &Parts) -> Result<(), axum::response::Response> {
    use axum::response::IntoResponse;
    let opts = IndexerOptions::from(&st.settings());
    if !opts.enabled() {
        return Err(axum::http::StatusCode::NOT_FOUND.into_response());
    }
    let presented = bearer(parts);
    if let Some(t) = &presented {
        if let Some(expected) = &opts.service_token
            && token_matches(t, expected)
        {
            return Ok(());
        }
        if !access_token::looks_like(t)
            && let Some(p) = st.auth.authenticate(st, t).await
            && p.service.as_deref() == Some("indexer")
        {
            return Ok(());
        }
    }
    let _ = PEER_CLAIM;
    let mut r = crate::error::raw_json(401, crate::error::indexer_error_json("unauthorized", "Jeton de service absent ou invalide.").to_string());
    r.headers_mut().insert(axum::http::header::WWW_AUTHENTICATE, axum::http::HeaderValue::from_static("Bearer"));
    let _ = r.status();
    Err(r.into_response())
}

pub fn token_matches(presented: &str, expected: &str) -> bool {
    let a = Sha256::digest(presented.as_bytes());
    let b = Sha256::digest(expected.as_bytes());
    a.iter().zip(b.iter()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jwt() -> JwtOptions {
        JwtOptions { secret: Some("test_secret_with_at_least_32_chars!!".into()), issuer: "savoire-server".into(), audience: "savoire-client".into() }
    }

    #[test]
    fn share_token_round_trip() {
        let link = ShareLink::create(crate::domain::ResourceType::Document, "d1", crate::domain::Permission::Read, "u", None, None);
        let t = share_link_token(&jwt(), &link).unwrap();
        assert_eq!(issuer_of(&t).as_deref(), Some("savoire-server"));
        let p = verify_local(&jwt(), &t).unwrap();
        assert_eq!(p.sub, format!("share:{}", link.id));
    }

    #[test]
    fn view_grant_round_trip() {
        let g = ViewGrant {
            vault_id: "v".into(),
            doc_id: "d".into(),
            path: "a.md".into(),
            permission: "write".into(),
            user_id: Some("u1".into()),
            expires_at: now() + chrono::Duration::minutes(2),
        };
        let t = view_grant_token(&jwt(), &g).unwrap();
        let back = read_view_grant(&jwt(), &t).unwrap();
        assert_eq!((back.vault_id.as_str(), back.doc_id.as_str(), back.user_id.as_deref()), ("v", "d", Some("u1")));
        let access = view_access_token(&jwt(), &g).unwrap();
        let p = verify_local(&jwt(), &access).unwrap();
        assert_eq!(p.sub, "view:v:d:write");
        assert_eq!(p.view_user_id.as_deref(), Some("u1"));
        // Un jeton d'acces de vue se relit aussi comme un grant (sub « view: »).
        assert!(read_view_grant(&jwt(), &access).is_ok());
    }

    #[test]
    fn expired_view_grant_is_refused() {
        let g = ViewGrant { vault_id: "v".into(), doc_id: "d".into(), path: "".into(), permission: "read".into(), user_id: None, expires_at: now() - chrono::Duration::minutes(5) };
        let t = view_grant_token(&jwt(), &g).unwrap();
        match read_view_grant(&jwt(), &t) {
            Err(AppError::AccessDenied(m)) => assert_eq!(m, "View grant expiré."),
            other => panic!("{other:?}"),
        }
        let mut other = jwt();
        other.secret = Some("another_secret_with_at_least_32_chars".into());
        assert!(verify_local(&other, &view_grant_token(&jwt(), &ViewGrant { expires_at: now() + chrono::Duration::minutes(1), ..g }).unwrap()).is_none());
    }

    #[test]
    fn access_token_format() {
        let t = access_token::generate();
        assert!(access_token::looks_like(&t));
        assert!(!access_token::looks_like("eyJhbGciOi.x.y"));
        assert_eq!(access_token::display(&t).len(), 10);
        assert_eq!(access_token::hash("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn constant_time_compare() {
        assert!(token_matches("secret", "secret"));
        assert!(!token_matches("secret", "secreT"));
    }
}
