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

pub const ACTIONS: [&str; 8] = ["read", "comment", "edit", "create", "organize", "delete", "plugin", "delegate"];

/// Les modes qui ont un sens pour chaque action (AGENT_ACTION_MODES).
fn modes_of(action: &str) -> &'static [&'static str] {
    match action {
        "read" => &["direct", "deny"],
        "comment" | "create" | "organize" | "delete" | "delegate" => &["direct", "ask", "deny"],
        "edit" | "plugin" => &["direct", "ask", "propose", "deny"],
        _ => &["deny"],
    }
}

/// Le mode d'une action pour cet agent ; un mode sans sens (ou absent) : 'deny'.
pub fn mode_for(definition: &Value, action: &str) -> &'static str {
    let asked = definition.get("permissions").and_then(|p| p.get(action)).and_then(Value::as_str).unwrap_or("deny");
    modes_of(action).iter().find(|m| **m == asked).copied().unwrap_or("deny")
}

/// Un lecteur du vault ne fait jamais ecrire un agent. Deleguer n'ecrit rien :
/// le sous-agent, lui, reste borne par la personne.
pub fn effective_mode(definition: &Value, action: &str, can_write: bool) -> &'static str {
    let m = mode_for(definition, action);
    if action != "read" && action != "delegate" && !can_write { "deny" } else { m }
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
const MAX_DELEGATES: usize = 50;

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
    for k in ["scope", "budget", "source", "watch"] {
        if let Some(v) = o.get(k).filter(|v| v.is_object()) {
            def[k] = v.clone();
        }
    }
    // Orchestrateur : les agents (ids) a qui il peut confier une tache.
    if let Some(ids) = o.get("delegates").and_then(Value::as_array) {
        let ids: Vec<&str> = ids.iter().filter_map(Value::as_str).filter(|v| !v.is_empty() && v.len() <= 200).take(MAX_DELEGATES).collect();
        if !ids.is_empty() {
            def["delegates"] = json!(ids);
        }
    }
    for k in ["connectionId", "model"] {
        if let Some(v) = o.get(k).and_then(Value::as_str).filter(|v| !v.is_empty() && v.len() <= 200) {
            def[k] = json!(v);
        }
    }
    // Changer de mode : permis par defaut ; seul « non » est garde.
    if o.get("canRequestMode").and_then(Value::as_bool) == Some(false) {
        def["canRequestMode"] = json!(false);
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
            Some(agent) if a.tool == REQUEST_MODE => apply_mode_request(&st, &p.sub, agent, &a.args).await?,
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
    if a.tool == crate::api::open::ADD_IMAGE && out.status != "done" {
        crate::api::open::drop_received_image(&st, &a.vault_id, &a.args).await;
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

// ── Changer de mode : edition ou revision (MCP request_mode) ─────────────────
//
// L'IA demande, la personne accepte ou refuse dans Savoire : un accord comme
// les autres (outil « request_mode »). Accepte : les modes « modifier » et
// « creer » changent dans la definition de l'agent. Une action interdite le
// reste : changer de mode ne donne aucun droit nouveau. Les droits de la
// personne bornent toujours le resultat (plan, effective_mode).

pub const REQUEST_MODE: &str = "request_mode";
const MAX_REASON_CHARS: usize = 500;

/// L'agent peut-il demander a changer de mode ? Oui, sauf si la personne l'a coupe.
pub fn can_request_mode(definition: &Value) -> bool {
    definition.get("canRequestMode").and_then(Value::as_bool) != Some(false)
}

/// Les droits apres le changement : edition ('direct') ou revision ('propose').
/// Creer n'a pas de mode proposition : en revision, il demande avant.
pub fn switch_mode(definition: &Value, mode: &str) -> Value {
    let (edit, create) = if mode == "direct" { ("direct", "direct") } else { ("propose", "ask") };
    let mut d = definition.clone();
    for (action, m) in [("edit", edit), ("create", create)] {
        if mode_for(&d, action) != "deny" {
            d["permissions"][action] = json!(m);
        }
    }
    d
}

fn mode_title(mode: &str) -> &'static str {
    if mode == "direct" { "édition (modifications directes)" } else { "révision (modifications proposées dans Révision)" }
}

fn action_label(action: &str) -> &'static str {
    match action {
        "read" => "Lire et chercher",
        "comment" => "Commenter",
        "edit" => "Modifier les notes",
        "create" => "Créer des notes et des dossiers",
        "organize" => "Déplacer et renommer",
        "delete" => "Mettre à la corbeille",
        "plugin" => "Actions des plugins",
        _ => "Déléguer à un sous-agent",
    }
}

fn mode_label(mode: &str) -> &'static str {
    match mode {
        "direct" => "oui",
        "ask" => "demander l'autorisation avant d'écrire",
        "propose" => "proposer (Révision)",
        _ => "non",
    }
}

/// Les modes de l'agent, en francais court (outil get_mode).
/// `can_write` : la personne peut-elle ecrire dans le vault demande ? None : pas de vault.
pub fn describe_mode(agent: &AgentRow, can_write: Option<bool>, pending: Option<&str>) -> String {
    let def = &agent.definition;
    let w = can_write.unwrap_or(true);
    let head = match effective_mode(def, "edit", w) {
        "direct" => "est en mode édition : ses modifications s'appliquent directement.",
        "propose" => "est en mode révision : ses modifications deviennent des propositions dans Révision.",
        "ask" => "demande l'autorisation avant d'écrire : chaque modification attend l'accord de la personne.",
        _ => "ne modifie pas les notes.",
    };
    let mut out = format!("« {} » {head}\n", agent.name);
    for a in ACTIONS {
        let m = effective_mode(def, a, w);
        if m != "deny" || a == "edit" || a == "create" {
            out.push_str(&format!("- {} : {}\n", action_label(a), mode_label(m)));
        }
    }
    match can_write {
        Some(false) => out.push_str("Dans ce vault, la personne ne peut que lire : l'agent n'y écrit pas.\n"),
        Some(true) => {}
        None => out.push_str("Ces modes restent bornés par les droits de la personne dans chaque vault.\n"),
    }
    if let Some(id) = pending {
        out.push_str(&format!("Une demande de changement de mode attend l'accord de la personne (accord {id}).\n"));
    } else if can_request_mode(def) {
        out.push_str("Pour changer : request_mode, avec l'accord de la personne.\n");
    } else {
        out.push_str("Cet agent ne peut pas demander à changer de mode.\n");
    }
    out
}

/// Demande de passer en edition ('direct') ou en revision ('propose') : mise en attente de l'accord.
pub async fn request_mode(st: &AppState, user: &str, agent: &AgentRow, mode: &str, reason: &str) -> AppResult<ToolOutcome> {
    let def = &agent.definition;
    if !can_request_mode(def) {
        return Ok(ToolOutcome::error(&format!("« {} » ne peut pas demander à changer de mode (réglage de l'agent dans Savoire).", agent.name)));
    }
    if mode != "direct" && mode != "propose" {
        return Ok(ToolOutcome::error("mode : direct (édition) ou propose (révision)."));
    }
    if mode_for(def, "edit") == "deny" && mode_for(def, "create") == "deny" {
        return Ok(ToolOutcome::error(&format!("« {} » ne modifie ni ne crée de notes : il n'a pas de mode à changer.", agent.name)));
    }
    if switch_mode(def, mode) == *def {
        return Ok(ToolOutcome { text: format!("« {} » est déjà en mode {}.", agent.name, mode_title(mode)), is_error: false });
    }
    let mut c = st.db.acquire().await?;
    // Accepter changera l'agent : il faut que la personne puisse le modifier.
    if !can_edit(&mut c, user, agent).await? {
        return Ok(ToolOutcome::error("Seul un administrateur du vault peut changer le mode de cet agent."));
    }
    if let Some(p) = db::approval_pending(&mut c, user, &agent.id, REQUEST_MODE).await? {
        return Ok(ToolOutcome { text: format!("Une demande de changement de mode attend déjà l'accord de la personne (accord {}). Ne la refaites pas.", p.id), is_error: false });
    }
    let reason: String = reason.trim().chars().take(MAX_REASON_CHARS).collect();
    let summary = if reason.is_empty() { format!("Passer en mode {}", mode_title(mode)) } else { format!("Passer en mode {} : {reason}", mode_title(mode)) };
    let vault_id = agent.vault_id.clone().unwrap_or_default();
    let a = ApprovalRow {
        id: new_id_n(), agent_id: agent.id.clone(), user_id: user.into(), vault_id: vault_id.clone(), tool: REQUEST_MODE.into(),
        args: json!({ "mode": mode, "reason": reason }), summary: summary.clone(), status: "pending".into(), result: None,
        created_at: now(), decided_at: None,
    };
    db::approval_add(&mut c, &a).await?;
    db::action_add(&mut c, &db::ActionRow { agent_id: &agent.id, user_id: user, vault_id: &vault_id, tool: REQUEST_MODE, action: "mode", mode: "ask", status: "pending", summary: &summary }).await?;
    Ok(ToolOutcome {
        text: format!(
            "Demande en attente de validation dans Savoire (accord {}) : passer en mode {}. Le mode ne change que si la personne l'accepte, dans le panneau Agents > Activité. Ne la refaites pas.",
            a.id, mode_title(mode)
        ),
        is_error: false,
    })
}

/// Accord donne : les modes changent, avec les droits d'AUJOURD'HUI sur l'agent.
async fn apply_mode_request(st: &AppState, user: &str, agent: &AgentRow, args: &Value) -> AppResult<ToolOutcome> {
    let mode = args.get("mode").and_then(Value::as_str).unwrap_or("");
    if mode != "direct" && mode != "propose" {
        return Ok(ToolOutcome::error("Demande de mode illisible."));
    }
    let mut c = st.db.acquire().await?;
    if !can_edit(&mut c, user, agent).await? {
        return Ok(ToolOutcome::error("Vous ne pouvez pas modifier cet agent."));
    }
    let mut row = agent.clone();
    row.definition = switch_mode(&agent.definition, mode);
    row.updated_at = now();
    db::update(&mut c, &row).await?;
    Ok(ToolOutcome { text: format!("« {} » est maintenant en mode {}.", agent.name, mode_title(mode)), is_error: false })
}

// ── API interne : ecritures du pair ──────────────────────────────────────────

#[derive(Deserialize)]
pub struct WriteRequest {
    ticket: Option<String>,
    /// Documents a inscrire dans le vault (notes creees).
    register: Option<Vec<String>>,
    /// Dossier de chaque document touche (ACL) : { docId, folder }.
    folders: Option<Vec<Placement>>,
    /// Fichiers recus par le serveur (images des IA), inscrits par cet appel : leur note.
    attach: Option<Vec<Attach>>,
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
pub struct Attach {
    doc_id: String,
    note_id: String,
    name: String,
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

    // 0. Un fichier recu ne s'inscrit que neuf : ses octets sont la, il n'est encore
    // le document de personne, et il est inscrit par ce meme appel.
    let attach = req.attach.unwrap_or_default();
    for a in &attach {
        if propose_only {
            return Ok(internal_error(403, "denied", "Mode proposition : l'agent n'ajoute pas de fichier."));
        }
        if !crate::api::open::FILE_ID_SHAPE.is_match(&a.doc_id) || !req.register.as_ref().is_some_and(|r| r.contains(&a.doc_id)) || a.name.contains('/') || a.name.encode_utf16().count() > 255 {
            return Ok(internal_error(400, "invalid_query", "Fichier joint mal décrit."));
        }
        if repos::doc_get(&mut c, &a.doc_id).await?.is_some() || st.store.read(&vault_id, &a.doc_id).await?.is_none() {
            return Ok(internal_error(403, "denied", "Ce fichier n'est pas un envoi en attente."));
        }
        match repos::doc_get(&mut c, &a.note_id).await? {
            Some(n) if n.vault_id == vault_id => {}
            _ => return Ok(internal_error(403, "denied", "Note inconnue dans ce vault.")),
        }
    }

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
    for a in &attach {
        // Range avec sa note (partage), puis relu par le pair (texte d'une image).
        repos::doc_set_placement(&mut c, &a.doc_id, Some(&a.note_id), Some(&a.name)).await?;
        repos::indexer_record_file(&mut c, &a.doc_id).await?;
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
    fn delegate() {
        let d = json!({ "permissions": { "delegate": "ask" } });
        assert_eq!(mode_for(&d, "delegate"), "ask");
        // Deleguer n'ecrit rien : permis meme a un lecteur.
        assert_eq!(effective_mode(&d, "delegate", false), "ask");
        assert_eq!(mode_for(&json!({ "permissions": { "delegate": "propose" } }), "delegate"), "deny");
        let (_, _, def) = clean_definition(&json!({ "name": "Chef", "permissions": { "delegate": "direct" }, "delegates": ["a", "", 3, "b"] })).unwrap();
        assert_eq!(def["permissions"]["delegate"], "direct");
        assert_eq!(def["delegates"], json!(["a", "b"]));
        let (_, _, def) = clean_definition(&json!({ "name": "Seul" })).unwrap();
        assert_eq!(def["permissions"]["delegate"], "deny");
        assert!(def.get("delegates").is_none());
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

    // Memes cas que tests/frontend/unit/agent-core-tests (switchMode).
    #[test]
    fn mode_switch() {
        let d = json!({ "permissions": { "read": "direct", "edit": "propose", "create": "ask", "delete": "ask" } });
        let e = switch_mode(&d, "direct");
        assert_eq!((mode_for(&e, "edit"), mode_for(&e, "create")), ("direct", "direct"));
        // Les autres actions ne bougent pas.
        assert_eq!(mode_for(&e, "delete"), "ask");
        let r = switch_mode(&e, "propose");
        assert_eq!((mode_for(&r, "edit"), mode_for(&r, "create")), ("propose", "ask"));
        // Une action interdite le reste.
        let only_edit = json!({ "permissions": { "edit": "ask" } });
        assert_eq!(mode_for(&switch_mode(&only_edit, "direct"), "create"), "deny");
        assert_eq!(mode_for(&switch_mode(&only_edit, "direct"), "edit"), "direct");
        // La personne borne toujours : un lecteur ne fait pas ecrire l'agent.
        assert_eq!(effective_mode(&e, "edit", false), "deny");
    }

    #[test]
    fn mode_request_option() {
        assert!(can_request_mode(&json!({})));
        assert!(!can_request_mode(&json!({ "canRequestMode": false })));
        let (_, _, def) = clean_definition(&json!({ "name": "A", "canRequestMode": false })).unwrap();
        assert_eq!(def["canRequestMode"], false);
        let (_, _, def) = clean_definition(&json!({ "name": "A", "canRequestMode": true })).unwrap();
        assert!(def.get("canRequestMode").is_none());
    }

    #[test]
    fn mode_text() {
        let at = now();
        let mut a = AgentRow { id: "a".into(), owner_id: "u".into(), vault_id: None, name: "Secrétaire".into(),
            definition: json!({ "permissions": { "read": "direct", "edit": "propose", "create": "ask" } }), created_at: at, updated_at: at };
        let t = describe_mode(&a, None, None);
        assert!(t.starts_with("« Secrétaire » est en mode révision"), "{t}");
        assert!(t.contains("- Créer des notes et des dossiers : demander l'autorisation avant d'écrire"), "{t}");
        assert!(t.contains("request_mode"));
        assert!(describe_mode(&a, None, Some("x1")).contains("accord x1"));
        assert!(describe_mode(&a, Some(false), None).contains("ne peut que lire"));
        a.definition["canRequestMode"] = json!(false);
        assert!(describe_mode(&a, None, None).contains("ne peut pas demander"));
    }

    #[test]
    fn summary() {
        assert_eq!(summarize("move_note", &json!({ "path": "a.md", "to": "B/" })), "move_note : path=a.md, to=B/");
        assert_eq!(summarize("x", &json!({})), "x");
    }
}
