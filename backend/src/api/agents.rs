// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Agents IA (ADR-033).
//
// Un agent est une identite declaree : un nom, des consignes, des droits par
// action, une portee. Le serveur le garde pour verifier ce que fait une IA
// externe (ChatGPT, Claude) qui porte un jeton rattache a cet agent.
//
// Routes (compte connecte) :
//   GET    /api/v1/agents                         les miens et ceux de mes vaults
//   POST   /api/v1/agents                         creer
//   PUT    /api/v1/agents/{id}                    modifier
//   DELETE /api/v1/agents/{id}                    supprimer
//   POST   /api/v1/agents/{id}/usage              tokens consommes dans l'appli
//   GET    /api/v1/agents/usage?days=             ma consommation par jour
//   GET    /api/v1/agents/approvals               accords (en attente d'abord)
//   POST   /api/v1/agents/approvals/{id}/decide   { approve }
//   GET    /api/v1/agents/actions?limit=          journal des actions externes
// API interne (pair indexeur, jeton de service) :
//   POST   /internal/indexer/vaults/{vaultId}/write   ecritures d'un outil, avec un ticket
//
// Les droits sont verifies DEUX fois : avant de relayer l'appel au pair
// (mode de l'action, portee de l'agent), puis a l'ecriture (ticket, ACL de la
// personne). Le pair ne decide jamais seul.

use std::time::{Duration, Instant};

use axum::extract::{Path, Query, State};
use axum::response::Response;
use base64::Engine;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgConnection;

use super::{Body, ReqParts, no_content, ok};
use crate::access::{self, Level};
use crate::api::indexer::{TOOLS_CAPABILITY, call_indexer};
use crate::auth::{Auth, indexer_peer_allowed};
use crate::db::agents::{self as db, AgentRow, ApprovalRow, UsageDelta};
use crate::db::repos;
use crate::domain::{Operation, crdt, folder_resource, is_link_caller, new_id_n, now};
use crate::error::{AppError, AppResult, indexer_error_json, raw_json};
use crate::realtime::event;
use crate::state::AppState;

// ── Droits (copie courte de packages/agent-core/src/policy.ts) ──────────────

pub const ACTIONS: [&str; 7] = ["read", "comment", "edit", "create", "organize", "delete", "plugin"];

/// Les modes qui ont un sens pour chaque action (AGENT_ACTION_MODES).
fn modes_of(action: &str) -> &'static [&'static str] {
    match action {
        "read" => &["direct", "deny"],
        "comment" | "create" | "organize" | "delete" => &["direct", "ask", "deny"],
        "edit" | "plugin" => &["direct", "ask", "propose", "deny"],
        _ => &["deny"],
    }
}

/// Le mode d'une action pour cet agent ; un mode sans sens (ou absent) : 'deny'.
pub fn mode_for(definition: &Value, action: &str) -> &'static str {
    let asked = definition.get("permissions").and_then(|p| p.get(action)).and_then(Value::as_str).unwrap_or("deny");
    modes_of(action).iter().find(|m| **m == asked).copied().unwrap_or("deny")
}

/// Un lecteur du vault ne fait jamais ecrire un agent.
pub fn effective_mode(definition: &Value, action: &str, can_write: bool) -> &'static str {
    let m = mode_for(definition, action);
    if action != "read" && !can_write { "deny" } else { m }
}

/// Le vault est-il dans la portee de l'agent ?
pub fn vault_in_scope(definition: &Value, vault_id: &str) -> bool {
    match definition.get("scope").and_then(|s| s.get("vaultIds")).and_then(Value::as_array) {
        Some(ids) if !ids.is_empty() => ids.iter().any(|v| v.as_str() == Some(vault_id)),
        _ => true,
    }
}

/// Droits d'un jeton sans agent : lecture seule (comportement d'avant ADR-033).
pub fn read_only_definition() -> Value {
    json!({ "name": "Jeton API", "permissions": { "read": "direct" } })
}

/// La personne peut-elle utiliser cet agent ? Le sien, ou un agent d'un vault ou elle est membre.
pub async fn can_use(c: &mut PgConnection, user: &str, agent: &AgentRow) -> AppResult<bool> {
    match &agent.vault_id {
        None => Ok(agent.owner_id == user),
        Some(v) => Ok(access::require_read(c, user, v).await.is_ok()),
    }
}

/// Peut-elle le modifier ? Le sien ; un agent du vault : administrateur du vault.
async fn can_edit(c: &mut PgConnection, user: &str, agent: &AgentRow) -> AppResult<bool> {
    match &agent.vault_id {
        None => Ok(agent.owner_id == user),
        Some(v) => Ok(access::require_admin(c, user, v).await.is_ok()),
    }
}

// ── Agents ───────────────────────────────────────────────────────────────────

const MAX_DEFINITION_BYTES: usize = 64 * 1024;
const MAX_INSTRUCTIONS_CHARS: usize = 20_000;

fn dto(a: &AgentRow) -> Value {
    let mut v = a.definition.clone();
    if !v.is_object() {
        v = json!({});
    }
    v["id"] = json!(a.id);
    v["ownerId"] = json!(a.owner_id);
    v["name"] = json!(a.name);
    match &a.vault_id {
        Some(id) => v["vaultId"] = json!(id),
        None => {
            v.as_object_mut().unwrap().remove("vaultId");
        }
    }
    v["createdAt"] = json!(a.created_at);
    v["updatedAt"] = json!(a.updated_at);
    v
}

/// Une definition propre : les champs connus, des droits valides, des bornes.
fn clean_definition(body: &Value) -> AppResult<(String, Option<String>, Value)> {
    let Some(o) = body.as_object() else { return Err(AppError::validation("Objet JSON attendu.")) };
    if body.to_string().len() > MAX_DEFINITION_BYTES {
        return Err(AppError::validation("Définition trop grande (64 Kio au plus)."));
    }
    let text = |k: &str| o.get(k).and_then(Value::as_str).map(str::trim).unwrap_or("").to_string();
    let name = text("name");
    if name.is_empty() || name.chars().count() > 100 {
        return Err(AppError::validation("Le nom de l'agent fait de 1 a 100 caracteres."));
    }
    let instructions = o.get("instructions").and_then(Value::as_str).unwrap_or("").to_string();
    if instructions.chars().count() > MAX_INSTRUCTIONS_CHARS {
        return Err(AppError::validation("Les consignes font 20 000 caracteres au plus."));
    }
    let mut permissions = serde_json::Map::new();
    for a in ACTIONS {
        let m = o.get("permissions").and_then(|p| p.get(a)).and_then(Value::as_str).unwrap_or("deny");
        let m = modes_of(a).iter().find(|x| **x == m).copied().unwrap_or("deny");
        permissions.insert(a.into(), json!(m));
    }
    let vault_id = o.get("vaultId").and_then(Value::as_str).filter(|v| !v.is_empty()).map(str::to_string);
    let mut def = json!({
        "name": name,
        "description": text("description"),
        "instructions": instructions,
        "permissions": permissions,
    });
    for k in ["scope", "budget", "source"] {
        if let Some(v) = o.get(k).filter(|v| v.is_object()) {
            def[k] = v.clone();
        }
    }
    for k in ["connectionId", "model"] {
        if let Some(v) = o.get(k).and_then(Value::as_str).filter(|v| !v.is_empty() && v.len() <= 200) {
            def[k] = json!(v);
        }
    }
    Ok((name, vault_id, def))
}

fn require_account(caller: &str) -> AppResult<()> {
    if is_link_caller(caller) {
        return Err(AppError::denied("Un lien de partage ne gere pas d'agents."));
    }
    Ok(())
}

async fn my_vault_ids(c: &mut PgConnection, user: &str) -> AppResult<Vec<String>> {
    Ok(repos::vaults_for_user(c, user).await?.into_iter().map(|(v, _)| v.id).collect())
}

pub async fn list(State(st): State<AppState>, Auth(p): Auth) -> AppResult<Response> {
    require_account(&p.sub)?;
    let mut c = st.db.acquire().await?;
    let vaults = my_vault_ids(&mut c, &p.sub).await?;
    let list: Vec<Value> = db::list_for(&mut c, &p.sub, &vaults).await?.iter().map(dto).collect();
    Ok(ok(&json!({ "agents": list })))
}

pub async fn create(State(st): State<AppState>, Auth(p): Auth, Body(body): Body<Value>) -> AppResult<Response> {
    require_account(&p.sub)?;
    let (name, vault_id, definition) = clean_definition(&body)?;
    let mut c = st.db.acquire().await?;
    if let Some(v) = &vault_id {
        access::require_admin(&mut c, &p.sub, v).await?;
    }
    let at = now();
    let row = AgentRow { id: new_id_n(), owner_id: p.sub.clone(), vault_id, name, definition, created_at: at, updated_at: at };
    db::insert(&mut c, &row).await?;
    Ok(ok(&dto(&row)))
}

pub async fn update(State(st): State<AppState>, Auth(p): Auth, Path(id): Path<String>, Body(body): Body<Value>) -> AppResult<Response> {
    require_account(&p.sub)?;
    let (name, vault_id, definition) = clean_definition(&body)?;
    let mut c = st.db.acquire().await?;
    let mut row = db::get(&mut c, &id).await?.ok_or_else(|| AppError::DocumentNotFound(id.clone()))?;
    if !can_edit(&mut c, &p.sub, &row).await? {
        return Err(AppError::denied("Vous ne pouvez pas modifier cet agent."));
    }
    if let Some(v) = &vault_id
        && row.vault_id.as_deref() != Some(v.as_str())
    {
        access::require_admin(&mut c, &p.sub, v).await?;
    }
    row.name = name;
    row.vault_id = vault_id;
    row.definition = definition;
    row.updated_at = now();
    db::update(&mut c, &row).await?;
    Ok(ok(&dto(&row)))
}

pub async fn delete(State(st): State<AppState>, Auth(p): Auth, Path(id): Path<String>) -> AppResult<Response> {
    require_account(&p.sub)?;
    let mut c = st.db.acquire().await?;
    let row = db::get(&mut c, &id).await?.ok_or_else(|| AppError::DocumentNotFound(id.clone()))?;
    if !can_edit(&mut c, &p.sub, &row).await? {
        return Err(AppError::denied("Vous ne pouvez pas supprimer cet agent."));
    }
    db::delete(&mut c, &id).await?;
    Ok(no_content())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRequest {
    input_tokens: Option<i64>,
    output_tokens: Option<i64>,
    runs: Option<i64>,
    calls: Option<i64>,
}

const MAX_USAGE_DELTA: i64 = 50_000_000;

pub async fn report_usage(State(st): State<AppState>, Auth(p): Auth, Path(id): Path<String>, Body(req): Body<UsageRequest>) -> AppResult<Response> {
    require_account(&p.sub)?;
    let bound = |v: Option<i64>| v.unwrap_or(0).clamp(0, MAX_USAGE_DELTA);
    let mut c = st.db.acquire().await?;
    let row = db::get(&mut c, &id).await?.ok_or_else(|| AppError::DocumentNotFound(id.clone()))?;
    if !can_use(&mut c, &p.sub, &row).await? {
        return Err(AppError::denied("Agent inaccessible."));
    }
    let d = UsageDelta { input_tokens: bound(req.input_tokens), output_tokens: bound(req.output_tokens), runs: bound(req.runs).min(1000), calls: bound(req.calls).min(100_000) };
    db::usage_add(&mut c, &id, &p.sub, &d).await?;
    Ok(no_content())
}

#[derive(Deserialize)]
pub struct DaysQuery {
    days: Option<i32>,
    limit: Option<i64>,
}

pub async fn usage(State(st): State<AppState>, Auth(p): Auth, Query(q): Query<DaysQuery>) -> AppResult<Response> {
    require_account(&p.sub)?;
    let mut c = st.db.acquire().await?;
    let days = db::usage_for(&mut c, &p.sub, q.days.unwrap_or(30).clamp(1, 366)).await?;
    Ok(ok(&json!({ "days": days })))
}

pub async fn actions(State(st): State<AppState>, Auth(p): Auth, Query(q): Query<DaysQuery>) -> AppResult<Response> {
    require_account(&p.sub)?;
    let mut c = st.db.acquire().await?;
    let list = db::actions_for(&mut c, &p.sub, q.limit.unwrap_or(100).clamp(1, 500)).await?;
    Ok(ok(&json!({ "actions": list })))
}

fn approval_dto(a: &ApprovalRow, agent_name: &str) -> Value {
    json!({
        "id": a.id, "agentId": a.agent_id, "agentName": agent_name, "vaultId": a.vault_id, "tool": a.tool, "args": a.args,
        "summary": a.summary, "status": a.status, "result": a.result, "createdAt": a.created_at, "decidedAt": a.decided_at,
    })
}

pub async fn approvals(State(st): State<AppState>, Auth(p): Auth) -> AppResult<Response> {
    require_account(&p.sub)?;
    let mut c = st.db.acquire().await?;
    let rows = db::approvals_for(&mut c, &p.sub, 100).await?;
    let mut out = vec![];
    for a in &rows {
        let name = db::get(&mut c, &a.agent_id).await?.map(|g| g.name).unwrap_or_else(|| "Agent supprimé".into());
        out.push(approval_dto(a, &name));
    }
    Ok(ok(&json!({ "approvals": out })))
}

#[derive(Deserialize)]
pub struct DecideRequest {
    approve: Option<bool>,
}

/// Accepter : l'action s'execute maintenant, sous le nom de l'agent, avec les droits d'AUJOURD'HUI.
pub async fn decide(State(st): State<AppState>, Auth(p): Auth, Path(id): Path<String>, Body(req): Body<DecideRequest>) -> AppResult<Response> {
    require_account(&p.sub)?;
    let approve = req.approve.unwrap_or(false);
    let mut c = st.db.acquire().await?;
    let a = db::approval_get(&mut c, &id).await?.filter(|a| a.user_id == p.sub).ok_or_else(|| AppError::DocumentNotFound(id.clone()))?;
    if !db::approval_decide(&mut c, &id, if approve { "approved" } else { "refused" }).await? {
        return Err(AppError::validation("Cette action n'est plus en attente."));
    }
    let agent = db::get(&mut c, &a.agent_id).await?;
    drop(c);
    let name = agent.as_ref().map(|g| g.name.clone()).unwrap_or_else(|| "Agent supprimé".into());
    let mut out = a.clone();
    if approve {
        let result = match &agent {
            None => ToolOutcome::error("L'agent a été supprimé."),
            Some(agent) => {
                let display = p.display_name.clone().unwrap_or_else(|| p.sub.clone());
                let call = ToolCall { user: &p.sub, display_name: &display, agent, vault_id: &a.vault_id, tool: &a.tool, args: &a.args };
                match plan(&st, &call).await? {
                    Plan::Deny(m) => ToolOutcome::error(&m),
                    // Accord donne : on fait (ou on propose, si c'est le mode de l'action).
                    Plan::Ask { action } => execute(&st, &call, &action, "direct").await?,
                    Plan::Run { action, mode } => execute(&st, &call, &action, &mode).await?,
                }
            }
        };
        let status = if result.is_error { "failed" } else { "done" };
        let mut c = st.db.acquire().await?;
        db::approval_finish(&mut c, &id, status, &result.text).await?;
        out.status = status.into();
        out.result = Some(result.text);
    } else {
        out.status = "refused".into();
    }
    out.decided_at = Some(now());
    Ok(ok(&approval_dto(&out, &name)))
}

// ── Appel d'un outil par le pair (MCP, accords) ──────────────────────────────

/// Un ticket d'ecriture : ce que le pair a le droit d'ecrire pendant UN appel.
#[derive(Debug, Clone)]
pub struct AgentTicket {
    pub user: String,
    pub display_name: String,
    pub agent_id: String,
    pub agent_name: String,
    pub vault_id: String,
    /// 'direct' : modifier ; 'propose' : seulement la Revision (map/review).
    pub mode: String,
    pub expires: Instant,
}

const TICKET_TTL: Duration = Duration::from_secs(60);

pub struct ToolCall<'a> {
    pub user: &'a str,
    pub display_name: &'a str,
    pub agent: &'a AgentRow,
    pub vault_id: &'a str,
    pub tool: &'a str,
    pub args: &'a Value,
}

pub enum Plan {
    Deny(String),
    /// Mode « demander » : mettre en attente.
    Ask { action: String },
    Run { action: String, mode: String },
}

pub struct ToolOutcome {
    pub text: String,
    pub is_error: bool,
}

impl ToolOutcome {
    pub fn error(m: &str) -> Self {
        ToolOutcome { text: m.into(), is_error: true }
    }
}

/// L'action d'un outil, d'apres le catalogue du pair. None : outil inconnu.
pub async fn tool_action(st: &AppState, user: &str, vault_id: &str, tool: &str) -> AppResult<Option<String>> {
    let catalog = catalog(st, user, vault_id).await?;
    Ok(catalog.iter().find(|t| t.get("name").and_then(Value::as_str) == Some(tool)).and_then(|t| t.get("action")).and_then(Value::as_str).map(str::to_string))
}

/// Le catalogue des outils du pair (tools.list), garde 5 minutes.
pub async fn catalog(st: &AppState, user: &str, vault_id: &str) -> AppResult<Vec<Value>> {
    if let Some((at, list)) = st.agent_catalog.lock().unwrap().clone()
        && at.elapsed() < Duration::from_secs(300)
    {
        return Ok(list);
    }
    let r = call_indexer(st, user, vault_id, TOOLS_CAPABILITY, "list", &json!({})).await?;
    if r.status != 200 {
        return Ok(vec![]);
    }
    let list: Vec<Value> = serde_json::from_str::<Value>(&r.json).ok().and_then(|v| v.get("tools").and_then(Value::as_array).cloned()).unwrap_or_default();
    if !list.is_empty() {
        *st.agent_catalog.lock().unwrap() = Some((Instant::now(), list.clone()));
    }
    Ok(list)
}

/// Ce que l'appel a le droit de faire, AVANT de relayer.
pub async fn plan(st: &AppState, call: &ToolCall<'_>) -> AppResult<Plan> {
    let def = &call.agent.definition;
    if !vault_in_scope(def, call.vault_id) || call.agent.vault_id.as_deref().is_some_and(|v| v != call.vault_id) {
        return Ok(Plan::Deny(format!("« {} » n'a pas accès à ce vault.", call.agent.name)));
    }
    let Some(action) = tool_action(st, call.user, call.vault_id, call.tool).await? else {
        return Ok(Plan::Deny(format!("Outil inconnu : {}.", call.tool)));
    };
    let mut c = st.db.acquire().await?;
    let can_write = access::require_write(&mut c, call.user, call.vault_id).await.is_ok();
    drop(c);
    Ok(match effective_mode(def, &action, can_write) {
        "deny" => Plan::Deny(format!("Droit refusé à « {} » pour cette action.", call.agent.name)),
        "ask" => Plan::Ask { action },
        m => Plan::Run { action, mode: m.into() },
    })
}

/// Met l'appel en attente de l'accord de la personne.
pub async fn hold(st: &AppState, call: &ToolCall<'_>, action: &str) -> AppResult<String> {
    let summary = summarize(call.tool, call.args);
    let a = ApprovalRow {
        id: new_id_n(), agent_id: call.agent.id.clone(), user_id: call.user.into(), vault_id: call.vault_id.into(),
        tool: call.tool.into(), args: call.args.clone(), summary: summary.clone(), status: "pending".into(), result: None,
        created_at: now(), decided_at: None,
    };
    let mut c = st.db.acquire().await?;
    db::approval_add(&mut c, &a).await?;
    db::action_add(&mut c, &db::ActionRow { agent_id: &call.agent.id, user_id: call.user, vault_id: call.vault_id, tool: call.tool, action, mode: "ask", status: "pending", summary: &summary }).await?;
    Ok(a.id)
}

/// Execute l'outil sur le pair, avec un ticket d'ecriture, et le note au journal.
pub async fn execute(st: &AppState, call: &ToolCall<'_>, action: &str, mode: &str) -> AppResult<ToolOutcome> {
    let ticket = new_id_n();
    let run_mode = if mode == "propose" { "propose" } else { "direct" };
    st.agent_tickets.insert(ticket.clone(), AgentTicket {
        user: call.user.into(), display_name: call.display_name.into(), agent_id: call.agent.id.clone(), agent_name: call.agent.name.clone(),
        vault_id: call.vault_id.into(), mode: run_mode.into(), expires: Instant::now() + TICKET_TTL,
    });
    let mut agent = call.agent.definition.clone();
    agent["id"] = json!(call.agent.id);
    agent["name"] = json!(call.agent.name);
    agent["ownerId"] = json!(call.agent.owner_id);
    let params = json!({
        "name": call.tool, "args": call.args, "mode": run_mode, "agent": agent, "ticket": ticket,
        "actor": { "agentId": call.agent.id, "agentName": call.agent.name, "onBehalfOf": { "userId": call.user, "displayName": call.display_name } },
    });
    let r = call_indexer(st, call.user, call.vault_id, TOOLS_CAPABILITY, "call", &params).await;
    st.agent_tickets.remove(&ticket);
    st.agent_tickets.retain(|_, t| t.expires > Instant::now());
    let outcome = match r {
        Err(e) => ToolOutcome::error(&e.to_string()),
        Ok(r) if r.status != 200 => ToolOutcome::error(&error_message(&r.json, r.status)),
        Ok(r) => {
            let v: Value = serde_json::from_str(&r.json).unwrap_or(Value::Null);
            ToolOutcome {
                text: v.get("text").and_then(Value::as_str).unwrap_or("").to_string(),
                is_error: v.get("isError").and_then(Value::as_bool).unwrap_or(false),
            }
        }
    };
    let mut c = st.db.acquire().await?;
    db::usage_add(&mut c, &call.agent.id, call.user, &UsageDelta { input_tokens: 0, output_tokens: 0, runs: 0, calls: 1 }).await?;
    if action != "read" {
        let summary = summarize(call.tool, call.args);
        db::action_add(&mut c, &db::ActionRow {
            agent_id: &call.agent.id, user_id: call.user, vault_id: call.vault_id, tool: call.tool, action, mode,
            status: if outcome.is_error { "failed" } else { "done" }, summary: &summary,
        })
        .await?;
    }
    Ok(outcome)
}

fn error_message(json: &str, status: u16) -> String {
    serde_json::from_str::<Value>(json)
        .ok()
        .and_then(|v| v.get("error")?.get("message")?.as_str().map(str::to_string))
        .unwrap_or_else(|| format!("Erreur {status}."))
}

/// « move_note : path=Inbox/a.md, to=Archives/ ».
pub fn summarize(tool: &str, args: &Value) -> String {
    let mut parts = vec![];
    if let Some(o) = args.as_object() {
        for (k, v) in o {
            let t = match v {
                Value::String(s) => s.clone(),
                Value::Null => continue,
                other => other.to_string(),
            };
            if t.is_empty() {
                continue;
            }
            let short: String = t.chars().take(120).collect();
            parts.push(format!("{k}={short}{}", if t.chars().count() > 120 { "…" } else { "" }));
        }
    }
    if parts.is_empty() { tool.to_string() } else { format!("{tool} : {}", parts.join(", ")) }
}

// ── API interne : ecritures du pair ──────────────────────────────────────────

#[derive(Deserialize)]
pub struct WriteRequest {
    ticket: Option<String>,
    /// Documents a inscrire dans le vault (notes creees).
    register: Option<Vec<String>>,
    /// Dossier de chaque document touche (ACL) : { docId, folder }.
    folders: Option<Vec<Placement>>,
    ops: Option<Vec<WriteOp>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Placement {
    doc_id: String,
    folder: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteOp {
    /// 'document', 'vault' (arborescence) ou 'index' (seul « map/review »).
    target: String,
    doc_id: Option<String>,
    ns: Option<String>,
    update: String,
}

const MAX_WRITE_OPS: usize = 32;
/// Seul canal partage qu'un agent ecrit : la Revision (commentaires, propositions, traces).
const REVIEW_NS: &str = "map/review";

fn internal_error(status: u16, code: &str, message: &str) -> Response {
    raw_json(status, indexer_error_json(code, message).to_string())
}

pub async fn internal_write(
    State(st): State<AppState>,
    ReqParts(parts): ReqParts,
    Path(vault_id): Path<String>,
    Body(req): Body<WriteRequest>,
) -> AppResult<Response> {
    if let Err(r) = indexer_peer_allowed(&st, &parts).await {
        return Ok(r);
    }
    let Some(ticket) = req.ticket.as_deref().and_then(|t| st.agent_tickets.get(t).map(|x| x.clone())) else {
        return Ok(internal_error(403, "invalid_ticket", "Ticket d'écriture inconnu ou expiré."));
    };
    if ticket.vault_id != vault_id || ticket.expires <= Instant::now() {
        return Ok(internal_error(403, "invalid_ticket", "Ticket d'écriture non valide pour ce vault."));
    }
    let ops = req.ops.unwrap_or_default();
    if ops.len() > MAX_WRITE_OPS {
        return Ok(internal_error(400, "invalid_query", "Trop d'opérations dans une écriture."));
    }
    let propose_only = ticket.mode == "propose";
    let user = ticket.user.as_str();
    let mut c = st.db.acquire().await?;
    let vault = repos::vault_get(&mut c, &vault_id).await?.ok_or_else(|| AppError::VaultNotFound(vault_id.clone()))?;

    // 1. Inscrire les notes creees, puis verifier les dossiers vises (ACL).
    if let Some(ids) = req.register.filter(|r| !r.is_empty()) {
        if propose_only {
            return Ok(internal_error(403, "denied", "Mode proposition : l'agent ne crée rien."));
        }
        access::check_vault(&mut c, user, &vault_id, Level::Write).await?;
        repos::docs_register(&mut c, &vault_id, &ids, user).await?;
    }
    for p in req.folders.unwrap_or_default() {
        if propose_only {
            return Ok(internal_error(403, "denied", "Mode proposition : l'agent ne range rien."));
        }
        let folder = folder_resource::normalize(Some(&p.folder)).ok_or_else(|| AppError::validation("Dossier invalide."))?;
        if !access::for_folder(&mut c, user, &vault, &folder).await?.can_write() {
            return Ok(internal_error(403, "denied", &format!("Écriture refusée dans le dossier « {folder} ».")));
        }
        access::check_document(&mut c, user, &vault_id, &p.doc_id, Level::Write).await?;
        repos::doc_set_folder(&mut c, &p.doc_id, &folder).await?;
    }

    // 2. Les operations, chacune verifiee, enregistrees avec leur auteur, diffusees.
    let author = json!({
        "id": user, "name": ticket.display_name, "guest": false,
        "agentId": ticket.agent_id, "agentName": ticket.agent_name,
    });
    let mut written = 0usize;
    for op in ops {
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(op.update.as_bytes()) else {
            return Ok(internal_error(400, "invalid_query", "Mise à jour illisible (base64)."));
        };
        let n = bytes.len() as i64;
        st.quota.ensure_room(&st.limits(), &vault_id, n).await?;
        match op.target.as_str() {
            "document" => {
                if propose_only {
                    return Ok(internal_error(403, "denied", "Mode proposition : l'agent ne modifie pas les notes."));
                }
                let doc_id = op.doc_id.ok_or_else(|| AppError::validation("docId manquant."))?;
                access::check_document(&mut c, user, &vault_id, &doc_id, Level::Write).await?;
                let o = Operation::create(crdt::DOCUMENT, &doc_id, &format!("agent:{}", ticket.agent_id), now(), bytes).by(author.clone());
                repos::op_append(&mut c, &o).await?;
                st.realtime.sync.send_group(&format!("doc:{doc_id}"), None, &event("ReceiveOperation", vec![json!(doc_id), json!(o.client_id), json!(op.update), author.clone()]));
            }
            "vault" => {
                if propose_only {
                    return Ok(internal_error(403, "denied", "Mode proposition : l'agent ne range rien."));
                }
                access::check_vault(&mut c, user, &vault_id, Level::Write).await?;
                let o = Operation::create(crdt::VAULT, &format!("vault:{vault_id}"), "vault-client", now(), bytes).by(author.clone());
                repos::op_append(&mut c, &o).await?;
                st.realtime.vault.send_group(&vault_id, None, &event("VaultOperationReceived", vec![json!(vault_id), json!(op.update)]));
            }
            "index" => {
                if op.ns.as_deref() != Some(REVIEW_NS) {
                    return Ok(internal_error(403, "denied", "Un agent n'écrit que dans la Révision."));
                }
                access::check_vault(&mut c, user, &vault_id, Level::Write).await?;
                let o = Operation::create(crdt::INDEX, &format!("index:{vault_id}:{REVIEW_NS}"), "server-relay", now(), bytes).by(author.clone());
                repos::op_append(&mut c, &o).await?;
                st.realtime.vault.send_group(&format!("idx:{vault_id}:{REVIEW_NS}"), None, &event("IndexUpdateReceived", vec![json!(vault_id), json!(REVIEW_NS), json!(op.update)]));
            }
            _ => return Ok(internal_error(400, "invalid_query", "target : document, vault ou index.")),
        }
        st.quota.added(&vault_id, n);
        written += 1;
    }
    Ok(ok(&json!({ "written": written })))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Memes cas que tests/frontend/unit/agent-core-tests (droits).
    #[test]
    fn modes() {
        let d = json!({ "permissions": { "read": "direct", "edit": "propose", "create": "propose", "delete": "ask" } });
        assert_eq!(mode_for(&d, "read"), "direct");
        assert_eq!(mode_for(&d, "edit"), "propose");
        // Un mode sans sens pour l'action devient interdit.
        assert_eq!(mode_for(&d, "create"), "deny");
        assert_eq!(mode_for(&d, "comment"), "deny");
        assert_eq!(mode_for(&d, "delete"), "ask");
        // Un lecteur ne fait jamais ecrire un agent.
        assert_eq!(effective_mode(&d, "edit", false), "deny");
        assert_eq!(effective_mode(&d, "read", false), "direct");
        assert_eq!(mode_for(&read_only_definition(), "edit"), "deny");
    }

    #[test]
    fn scope() {
        assert!(vault_in_scope(&json!({}), "v"));
        assert!(vault_in_scope(&json!({ "scope": { "vaultIds": [] } }), "v"));
        assert!(!vault_in_scope(&json!({ "scope": { "vaultIds": ["a"] } }), "v"));
    }

    #[test]
    fn clean() {
        let (name, vault, def) = clean_definition(&json!({ "name": " Archiviste ", "permissions": { "read": "direct", "edit": "nimporte" }, "extra": 1 })).unwrap();
        assert_eq!(name, "Archiviste");
        assert!(vault.is_none());
        assert_eq!(def["permissions"]["edit"], "deny");
        assert!(def.get("extra").is_none());
        assert!(clean_definition(&json!({ "name": "" })).is_err());
    }

    #[test]
    fn summary() {
        assert_eq!(summarize("move_note", &json!({ "path": "a.md", "to": "B/" })), "move_note : path=a.md, to=B/");
        assert_eq!(summarize("x", &json!({})), "x");
    }
}
