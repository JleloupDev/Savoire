// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Pair indexeur (ADR-027, docs/Architecture/indexer-protocol.md).
// Routes publiques (compte connecte, droit de lecture, jamais un lien) :
//   POST /api/v1/vaults/{vaultId}/index/{capability}/{method}
//   POST /api/v1/search
//   GET  /api/v1/vaults/{vaultId}/indexer
//   PUT  /api/v1/vaults/{vaultId}/indexer          (proprietaire)
// API interne, lue par le pair (jeton de service) :
//   GET /internal/indexer/vaults?instance=
//   GET /internal/indexer/changes?instance=&since=&limit=
//   GET /internal/indexer/vaults/{vaultId}/tree
//   GET /internal/indexer/vaults/{vaultId}/documents/{docId}
//   GET /internal/indexer/vaults/{vaultId}/files/{fileId}
//   GET /internal/indexer/vaults/{vaultId}/settings/{section}

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, LazyLock};

use axum::extract::{Path, Query, State};
use axum::http::{HeaderValue, header};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use regex::Regex;
use serde::Deserialize;
use serde_json::{Value, json};

use super::{Body, ReqParts, indexer_rate, ok, reply};
use crate::access::{self, Level};
use crate::auth::{Auth, indexer_peer_allowed};
use crate::db::repos;
use crate::domain::{IndexerMode, crdt, indexer_change_kind, is_link_caller};
use crate::error::{AppError, AppResult, indexer_error_json, raw_json};
use crate::options::IndexerOptions;
use crate::services::indexer::{self as idx, IndexerReply, Outcome, codes};
use crate::services::search;
use crate::state::AppState;

static NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z][a-z0-9_-]{0,63}$").unwrap());

fn require_account(caller: &str) -> AppResult<()> {
    if is_link_caller(caller) {
        return Err(AppError::denied("Un lien de partage ne donne pas acces au pair indexeur."));
    }
    Ok(())
}

fn none_configured(o: &IndexerOptions) -> IndexerReply {
    IndexerReply::unavailable("Aucun pair indexeur n'est configure sur ce serveur.", o.retry_after_seconds)
}

/// Appel d'un pouvoir du pair : droit de LIRE le vault, appelant ajoute, relaye a l'instance qui le possede.
pub async fn call_indexer(st: &AppState, caller: &str, vault_id: &str, capability: &str, method: &str, params: &Value) -> AppResult<IndexerReply> {
    let mut c = st.db.acquire().await?;
    access::check_vault(&mut c, caller, vault_id, Level::Read).await?;
    require_account(caller)?;
    let opts = IndexerOptions::from(&st.settings());
    if !opts.enabled() || opts.instances.is_empty() {
        return Ok(none_configured(&opts));
    }
    let setting = repos::indexer_setting(&mut c, vault_id).await?;
    drop(c);
    if setting.mode != IndexerMode::Managed {
        return Ok(IndexerReply::not_managed(&setting, opts.retry_after_seconds));
    }
    let body = idx::call_body(capability, method, params, caller);
    let owner = idx::owner_of(vault_id, &opts.instances).cloned().expect("au moins une instance");
    let mut response = st.peer.call(&opts, &owner, vault_id, body.clone()).await;
    // 409 not_owner : la liste des instances a change. Recalculer et reessayer une fois.
    if idx::is_not_owner(&response) {
        let opts2 = IndexerOptions::from(&st.settings());
        let again = idx::owner_of(vault_id, &opts2.instances).cloned();
        tracing::info!(instance = %owner.name, vault = vault_id, "Pair indexeur : ne possede pas le vault, nouvel essai");
        let Some(again) = again else { return Ok(none_configured(&opts2)) };
        response = st.peer.call(&opts2, &again, vault_id, body).await;
    }
    Ok(idx::to_reply(&response, &opts, true))
}

/// Corps JSON borne a Indexer:MaxBodyBytes ; `empty_as` : vide accepte comme cette valeur.
fn read_json_body(bytes: &[u8], max: i64, empty_as: Option<&str>) -> Result<String, IndexerReply> {
    if bytes.len() as i64 > max {
        return Err(IndexerReply::error(413, codes::PAYLOAD_TOO_LARGE, &format!("Corps limite a {max} octets."), None));
    }
    let text = String::from_utf8_lossy(bytes).into_owned();
    if text.trim().is_empty() {
        return match empty_as {
            Some(v) => Ok(v.to_string()),
            None => Err(IndexerReply::error(400, codes::INVALID_QUERY, "Corps JSON attendu.", None)),
        };
    }
    match serde_json::from_str::<Value>(&text) {
        Ok(_) => Ok(text),
        Err(_) => Err(IndexerReply::error(400, codes::INVALID_QUERY, "Corps JSON invalide.", None)),
    }
}

pub async fn call(
    State(st): State<AppState>,
    Auth(p): Auth,
    Path((vault_id, capability, method)): Path<(String, String, String)>,
    body: axum::body::Bytes,
) -> AppResult<Response> {
    if let Err(r) = indexer_rate(&st, &p.sub, Some(&vault_id)) {
        return Ok(r);
    }
    if !NAME.is_match(&capability) || !NAME.is_match(&method) {
        return Ok(reply(IndexerReply::error(400, codes::INVALID_QUERY, "Nom de pouvoir ou de methode invalide.", None)));
    }
    let opts = IndexerOptions::from(&st.settings());
    let json = match read_json_body(&body, opts.max_body_bytes, Some("{}")) {
        Ok(j) => j,
        Err(r) => return Ok(reply(r)),
    };
    let params: Value = serde_json::from_str(&json).unwrap_or(Value::Null);
    Ok(reply(call_indexer(&st, &p.sub, &vault_id, &capability, &method, &params).await?))
}

pub async fn search_route(State(st): State<AppState>, Auth(p): Auth, body: axum::body::Bytes) -> AppResult<Response> {
    if let Err(r) = indexer_rate(&st, &p.sub, None) {
        return Ok(r);
    }
    let opts = IndexerOptions::from(&st.settings());
    let json = match read_json_body(&body, opts.max_body_bytes, None) {
        Ok(j) => j,
        Err(r) => return Ok(reply(r)),
    };
    Ok(reply(search_all(&st, &p.sub, &json).await?))
}

const SEARCH_DEFAULT_LIMIT: i64 = 50;
const SEARCH_MAX_LIMIT: i64 = 500;
const MAX_VAULT_IDS: usize = 1000;

/// Recherche globale : vaults lisibles et servis par le pair gere, groupes par
/// instance, interroges en parallele, pages fusionnees par score. Une instance
/// en echec donne partial: true ; toutes en echec : 503.
pub async fn search_all(st: &AppState, caller: &str, body: &str) -> AppResult<IndexerReply> {
    require_account(caller)?;
    let opts = IndexerOptions::from(&st.settings());
    if !opts.enabled() || opts.instances.is_empty() {
        return Ok(none_configured(&opts));
    }
    let Some(mut query) = idx::parse_object(Some(body)) else {
        return Ok(IndexerReply::error(400, codes::INVALID_QUERY, "Corps attendu : un objet SearchQuery.", None));
    };
    let wanted: Option<HashSet<String>> = match query.remove("vaultIds") {
        None | Some(Value::Null) => None,
        Some(Value::Array(ids)) => {
            if ids.len() > MAX_VAULT_IDS || ids.iter().any(|v| !v.is_string()) {
                return Ok(IndexerReply::error(400, codes::INVALID_QUERY, &format!("vaultIds : au plus {MAX_VAULT_IDS} identifiants (texte)."), None));
            }
            Some(ids.into_iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        }
        Some(_) => return Ok(IndexerReply::error(400, codes::INVALID_QUERY, "vaultIds : liste attendue.", None)),
    };
    let cursor_text = match query.remove("cursor") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s),
        Some(_) => return Ok(IndexerReply::error(400, codes::INVALID_CURSOR, "cursor : texte attendu.", None)),
    };
    let limit = match query.get("limit") {
        None | Some(Value::Null) => SEARCH_DEFAULT_LIMIT,
        Some(v) => match v.as_i64().filter(|l| (1..=SEARCH_MAX_LIMIT).contains(l)) {
            Some(l) => l,
            None => return Ok(IndexerReply::error(400, codes::INVALID_QUERY, &format!("limit : entier de 1 a {SEARCH_MAX_LIMIT}."), None)),
        },
    };
    let mut c = st.db.acquire().await?;
    let mut seen = HashSet::new();
    let candidates: Vec<String> = repos::vaults_for_user(&mut c, caller)
        .await?
        .into_iter()
        .map(|(v, _)| v.id)
        .filter(|id| wanted.as_ref().is_none_or(|w| w.contains(id)))
        .filter(|id| seen.insert(id.clone()))
        .collect();
    let modes = repos::indexer_settings_many(&mut c, &candidates).await?;
    drop(c);
    let mut groups: BTreeMap<String, (crate::options::IndexerInstance, Vec<String>)> = BTreeMap::new();
    for id in candidates.iter().filter(|id| modes[*id].mode == IndexerMode::Managed) {
        let owner = idx::owner_of(id, &opts.instances).cloned().expect("instance");
        groups.entry(owner.name.clone()).or_insert_with(|| (owner, vec![])).1.push(id.clone());
    }
    let state = match cursor_text {
        None => search::Cursor::start(groups.keys()),
        Some(t) => match search::Cursor::decode(&t) {
            Some(c) => c,
            None => return Ok(IndexerReply::error(400, codes::INVALID_CURSOR, "Curseur illisible.", None)),
        },
    };
    let active: Vec<(String, crate::options::IndexerInstance, Vec<String>)> = groups
        .into_iter()
        .filter(|(name, _)| state.parts.contains_key(name))
        .map(|(name, (inst, ids))| (name, inst, ids))
        .collect();
    if active.is_empty() {
        let mut empty = json!({ "hits": [], "total": 0, "index": { "status": "ready" } });
        if state.partial {
            empty["partial"] = json!(true);
        }
        return Ok(IndexerReply::ok(empty.to_string()));
    }
    // Appels paralleles, bornes.
    let gate = Arc::new(tokio::sync::Semaphore::new(opts.search_parallelism.max(1) as usize));
    let mut tasks = vec![];
    for (name, inst, ids) in active {
        let part = state.parts[&name].clone();
        let mut instance_query = Value::Object(query.clone());
        if let Some(cur) = &part.cursor {
            instance_query["cursor"] = json!(cur);
        }
        let body = json!({ "vaultIds": ids, "query": instance_query, "caller": { "userId": caller } }).to_string().into_bytes();
        let gate = gate.clone();
        let st = st.clone();
        let opts = opts.clone();
        tasks.push(async move {
            let _permit = gate.acquire().await;
            let r = st.peer.search(&opts, &inst, body).await;
            (name, part, ids, r)
        });
    }
    let responses = futures::future::join_all(tasks).await;
    let mut partial = state.partial;
    let mut pages = vec![];
    let mut indexes = vec![];
    let mut total: i64 = 0;
    for (name, part, ids, r) in responses {
        let result = if r.is_success() { idx::parse_object(r.body.as_deref()) } else { None };
        let Some(result) = result.filter(|m| m.get("hits").is_some_and(Value::is_array)) else {
            // Une requete refusee l'est partout : la dire, plutot qu'un resultat vide.
            if r.outcome == Outcome::Answered && r.status == 400 {
                return Ok(idx::to_reply(&r, &opts, false));
            }
            tracing::warn!(instance = %name, outcome = ?r.outcome, status = r.status, "Recherche globale : instance sans reponse");
            partial = true;
            continue;
        };
        let mut hits = vec![];
        for h in result["hits"].as_array().unwrap() {
            let Some(mut hit) = h.as_object().cloned() else { continue };
            // Le pair renseigne vaultId ; s'il l'oublie et qu'un seul vault etait demande, on le sait.
            if !hit.contains_key("vaultId") && ids.len() == 1 {
                hit.insert("vaultId".into(), json!(ids[0]));
            }
            hits.push(hit);
        }
        let next = result.get("next").and_then(Value::as_str).map(str::to_string);
        if let Some(t) = result.get("total").and_then(Value::as_i64) {
            total += t;
        }
        indexes.push(result.get("index").and_then(Value::as_object).cloned());
        pages.push(search::InstancePage { instance: name, part, hits, next });
    }
    if pages.is_empty() {
        return Ok(IndexerReply::unavailable("Aucune instance du pair indexeur n'a repondu.", opts.retry_after_seconds));
    }
    let (merged, remaining) = search::merge(&pages, limit as usize);
    let mut out = json!({ "hits": merged, "total": total, "index": search::worst_index(&indexes) });
    if !remaining.is_empty() {
        out["next"] = json!(search::Cursor { parts: remaining, partial }.encode());
    }
    if partial {
        out["partial"] = json!(true);
    }
    Ok(IndexerReply::ok(out.to_string()))
}

fn setting_dto(mode: IndexerMode, url: Option<String>, state: Option<Value>) -> Value {
    let mut v = json!({ "mode": mode.as_str() });
    if mode == IndexerMode::Organization
        && let Some(u) = url
    {
        v["url"] = json!(u);
    }
    if let Some(s) = state {
        v["state"] = s;
    }
    v
}

/// Le pair qui sert le vault, et l'etat de son index.
pub async fn get_setting(State(st): State<AppState>, Auth(p): Auth, Path(vault_id): Path<String>) -> AppResult<Response> {
    if let Err(r) = indexer_rate(&st, &p.sub, Some(&vault_id)) {
        return Ok(r);
    }
    let mut c = st.db.acquire().await?;
    access::check_vault(&mut c, &p.sub, &vault_id, Level::Read).await?;
    require_account(&p.sub)?;
    let s = repos::indexer_setting(&mut c, &vault_id).await?;
    drop(c);
    if s.mode == IndexerMode::Organization {
        return Ok(ok(&setting_dto(s.mode, s.url, None)));
    }
    let opts = IndexerOptions::from(&st.settings());
    let mut state = None;
    if s.mode == IndexerMode::Managed
        && opts.enabled()
        && let Some(owner) = idx::owner_of(&vault_id, &opts.instances).cloned()
    {
        let r = st.peer.status(&opts, &owner, &vault_id).await;
        state = if r.is_success() { idx::parse_object(r.body.as_deref()).map(Value::Object) } else { None };
        if state.is_none() {
            tracing::info!(vault = %vault_id, instance = %owner.name, "Etat de l'index : pair indisponible");
        }
    }
    Ok(ok(&setting_dto(s.mode, s.url, Some(state.unwrap_or_else(|| json!({ "status": "unavailable" }))))))
}

#[derive(Deserialize)]
pub struct SettingRequest {
    mode: Option<String>,
    url: Option<String>,
}

pub async fn set_setting(State(st): State<AppState>, Auth(p): Auth, Path(vault_id): Path<String>, Body(req): Body<SettingRequest>) -> AppResult<Response> {
    if let Err(r) = indexer_rate(&st, &p.sub, Some(&vault_id)) {
        return Ok(r);
    }
    let mode_text = req.mode.unwrap_or_default();
    let Some(mode) = IndexerMode::parse(&mode_text) else {
        return Err(AppError::validation("mode : managed, organization ou none."));
    };
    let url = req.url.filter(|u| !u.is_empty());
    if mode == IndexerMode::Organization {
        let valid = url.as_deref().is_some_and(|u| {
            u.chars().count() <= 2048 && url::Url::parse(u).is_ok_and(|x| x.scheme() == "http" || x.scheme() == "https")
        });
        if !valid {
            return Err(AppError::validation("url : adresse http(s) absolue."));
        }
    } else if url.is_some() {
        return Err(AppError::validation("url : seulement pour le mode organization."));
    }
    let mut c = st.db.acquire().await?;
    access::check_vault(&mut c, &p.sub, &vault_id, Level::Read).await?;
    require_account(&p.sub)?;
    let vault = repos::vault_get(&mut c, &vault_id).await?.ok_or_else(|| AppError::VaultNotFound(vault_id.clone()))?;
    vault.require_owner(&p.sub)?;
    let setting = crate::domain::VaultIndexerSetting { vault_id: vault_id.clone(), mode, url: if mode == IndexerMode::Organization { url } else { None } };
    repos::indexer_setting_set(&mut c, &setting, &p.sub).await?;
    Ok(ok(&setting_dto(setting.mode, setting.url, None)))
}

// ── API interne ──────────────────────────────────────────────────────────────

fn internal_error(status: u16, code: &str, message: &str) -> Response {
    raw_json(status, indexer_error_json(code, message).to_string())
}

fn unknown_instance(opts: &IndexerOptions, instance: Option<&str>) -> Option<Response> {
    match instance.filter(|i| !i.trim().is_empty()) {
        None => Some(internal_error(400, codes::UNKNOWN_INSTANCE, "Parametre instance obligatoire.")),
        Some(i) if opts.find_instance(i).is_none() => {
            Some(internal_error(400, codes::UNKNOWN_INSTANCE, &format!("Instance « {i} » absente de Indexer:Instances.")))
        }
        _ => None,
    }
}

#[derive(Deserialize)]
pub struct InternalQuery {
    instance: Option<String>,
    since: Option<String>,
    limit: Option<String>,
}

fn updates(ops: &[crate::domain::Operation], format: &str) -> Value {
    let list: Vec<String> = ops.iter().map(|o| base64::engine::general_purpose::STANDARD.encode(&o.op_bytes)).collect();
    json!({ "updates": list, "format": format })
}

/// Rien pour un vault qui n'est pas servi par le pair gere.
async fn managed(c: &mut sqlx::PgConnection, vault_id: &str) -> AppResult<bool> {
    Ok(repos::indexer_setting(c, vault_id).await?.mode == IndexerMode::Managed)
}

pub async fn internal_vaults(State(st): State<AppState>, ReqParts(parts): ReqParts, Query(q): Query<InternalQuery>) -> AppResult<Response> {
    if let Err(r) = indexer_peer_allowed(&st, &parts).await {
        return Ok(r);
    }
    let opts = IndexerOptions::from(&st.settings());
    if let Some(r) = unknown_instance(&opts, q.instance.as_deref()) {
        return Ok(r);
    }
    let instance = q.instance.unwrap();
    let mut c = st.db.acquire().await?;
    let owned: Vec<_> = repos::vault_all(&mut c).await?.into_iter().filter(|v| idx::is_owner(&instance, &v.id, &opts.instances)).collect();
    let ids: Vec<String> = owned.iter().map(|v| v.id.clone()).collect();
    let modes = repos::indexer_settings_many(&mut c, &ids).await?;
    let list: Vec<Value> = owned
        .into_iter()
        .filter(|v| modes[&v.id].mode == IndexerMode::Managed)
        .map(|v| json!({ "vaultId": v.id, "name": v.name }))
        .collect();
    Ok(ok(&json!({ "vaults": list })))
}

const CHANGES_DEFAULT_LIMIT: i64 = 500;
const CHANGES_MAX_LIMIT: i64 = 2000;
const CHANGES_BATCH: i64 = 500;
const CHANGES_MAX_SCANNED: usize = 20_000;

/// Le flux global, filtre pour l'instance : les lignes des vaults qu'elle
/// possede et qui sont servis par le pair gere, plus les « vault-deleted ».
pub async fn internal_changes(State(st): State<AppState>, ReqParts(parts): ReqParts, Query(q): Query<InternalQuery>) -> AppResult<Response> {
    if let Err(r) = indexer_peer_allowed(&st, &parts).await {
        return Ok(r);
    }
    let opts = IndexerOptions::from(&st.settings());
    if let Some(r) = unknown_instance(&opts, q.instance.as_deref()) {
        return Ok(r);
    }
    let instance = q.instance.unwrap();
    let since: i64 = match q.since.as_deref() {
        None | Some("") => 0,
        Some(s) => match s.parse::<i64>() {
            Ok(v) => v,
            Err(_) => return Ok(super::problem(400, "One or more validation errors occurred.", "since : entier attendu.")),
        },
    };
    if since < 0 {
        return Ok(internal_error(400, codes::INVALID_CURSOR, "since : entier positif ou nul."));
    }
    let limit = q.limit.as_deref().and_then(|l| l.parse::<i64>().ok()).unwrap_or(CHANGES_DEFAULT_LIMIT).clamp(1, CHANGES_MAX_LIMIT) as usize;
    let mut c = st.db.acquire().await?;
    let epoch = repos::indexer_epoch(&mut c).await?;
    let mut last = since.max(0);
    let mut result: Vec<Value> = vec![];
    let mut managed_cache: HashMap<String, bool> = HashMap::new();
    let mut scanned = 0usize;
    'outer: while result.len() < limit && scanned < CHANGES_MAX_SCANNED {
        let batch = repos::indexer_changes_since(&mut c, last, CHANGES_BATCH).await?;
        if batch.is_empty() {
            break;
        }
        let unknown: Vec<String> = batch.iter().map(|b| b.vault_id.clone()).filter(|v| !managed_cache.contains_key(v)).collect::<HashSet<_>>().into_iter().collect();
        if !unknown.is_empty() {
            for (v, s) in repos::indexer_settings_many(&mut c, &unknown).await? {
                managed_cache.insert(v, s.mode == IndexerMode::Managed);
            }
        }
        let full = batch.len() as i64 == CHANGES_BATCH;
        for ch in batch {
            last = ch.seq;
            scanned += 1;
            let in_scope = ch.kind == indexer_change_kind::VAULT_DELETED || managed_cache.get(&ch.vault_id).copied().unwrap_or(true);
            if in_scope && idx::is_owner(&instance, &ch.vault_id, &opts.instances) {
                let mut v = json!({ "seq": ch.seq, "vaultId": ch.vault_id, "kind": ch.kind });
                if let Some(d) = ch.doc_id {
                    v["docId"] = json!(d);
                }
                result.push(v);
            }
            if result.len() == limit {
                break 'outer;
            }
        }
        if !full {
            break;
        }
    }
    Ok(ok(&json!({ "changes": result, "last": last, "epoch": epoch })))
}

pub async fn internal_tree(State(st): State<AppState>, ReqParts(parts): ReqParts, Path(vault_id): Path<String>) -> AppResult<Response> {
    if let Err(r) = indexer_peer_allowed(&st, &parts).await {
        return Ok(r);
    }
    let mut c = st.db.acquire().await?;
    if repos::vault_get(&mut c, &vault_id).await?.is_none() || !managed(&mut c, &vault_id).await? {
        return Ok(internal_error(404, "not_found", "Vault inconnu ou non servi par le pair gere."));
    }
    let ops = repos::ops_all(&mut c, crdt::VAULT, &format!("vault:{vault_id}")).await?;
    Ok(ok(&updates(&ops, "yjs")))
}

pub async fn internal_document(State(st): State<AppState>, ReqParts(parts): ReqParts, Path((vault_id, doc_id)): Path<(String, String)>) -> AppResult<Response> {
    if let Err(r) = indexer_peer_allowed(&st, &parts).await {
        return Ok(r);
    }
    let mut c = st.db.acquire().await?;
    let not_found = || internal_error(404, "not_found", "Document inconnu dans ce vault.");
    if repos::doc_vault_id(&mut c, &doc_id).await?.as_deref() != Some(vault_id.as_str()) || !managed(&mut c, &vault_id).await? {
        return Ok(not_found());
    }
    let ops = repos::ops_all(&mut c, crdt::DOCUMENT, &doc_id).await?;
    if !ops.is_empty() {
        return Ok(ok(&updates(&ops, "yjs")));
    }
    // Document « snapshot » (room : tableau...) : son dernier etat JSON.
    let room = repos::ops_all(&mut c, crdt::ROOM, &doc_id).await?;
    if let Some(last) = room.last() {
        return Ok(ok(&updates(std::slice::from_ref(last), "json")));
    }
    Ok(ok(&json!({ "updates": [], "format": "yjs" })))
}

pub async fn internal_file(State(st): State<AppState>, ReqParts(parts): ReqParts, Path((vault_id, file_id)): Path<(String, String)>) -> AppResult<Response> {
    if let Err(r) = indexer_peer_allowed(&st, &parts).await {
        return Ok(r);
    }
    let mut c = st.db.acquire().await?;
    let not_found = || internal_error(404, "not_found", "Fichier inconnu dans ce vault.");
    if repos::doc_vault_id(&mut c, &file_id).await?.as_deref() != Some(vault_id.as_str()) || !managed(&mut c, &vault_id).await? {
        return Ok(not_found());
    }
    drop(c);
    let Some(file) = st.store.read(&vault_id, &file_id).await? else { return Ok(not_found()) };
    let body = axum::body::Body::from_stream(tokio_util::io::ReaderStream::new(file));
    let mut r = body.into_response();
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"));
    Ok(r)
}

pub async fn internal_settings(State(st): State<AppState>, ReqParts(parts): ReqParts, Path((vault_id, section)): Path<(String, String)>) -> AppResult<Response> {
    if let Err(r) = indexer_peer_allowed(&st, &parts).await {
        return Ok(r);
    }
    let mut c = st.db.acquire().await?;
    let known = indexer_change_kind::SETTINGS_SECTIONS.contains(&section.as_str());
    if !known || repos::vault_get(&mut c, &vault_id).await?.is_none() || !managed(&mut c, &vault_id).await? {
        return Ok(internal_error(404, "not_found", "Vault inconnu, non servi par le pair gere, ou section de reglages inconnue."));
    }
    let ops = repos::ops_all(&mut c, crdt::INDEX, &format!("index:{vault_id}:settings/{section}")).await?;
    Ok(ok(&updates(&ops, "yjs")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_rules() {
        assert_eq!(read_json_body(b"", 10, Some("{}")).unwrap(), "{}");
        assert_eq!(read_json_body(b"  ", 10, None).unwrap_err().status, 400);
        assert_eq!(read_json_body(b"{\"a\":1}", 3, None).unwrap_err().status, 413);
        assert_eq!(read_json_body(b"{oops", 100, None).unwrap_err().status, 400);
        assert!(NAME.is_match("query") && !NAME.is_match("Query") && !NAME.is_match("1x"));
    }
}
