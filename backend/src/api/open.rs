// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// L'API ouverte : ce que ChatGPT, Claude, un script ou n8n peuvent faire avec
// un jeton personnel (Bearer svp_...). Deux portes, la meme logique derriere :
//  - REST : /api/open/v1/... (decrite dans open-api.yaml) ;
//  - MCP  : /api/mcp (JSON-RPC, transport « Streamable HTTP » sans SSE).
// REST : lecture seule (lister les vaults, chercher, lister les notes, lire
// une note, requetes).
// MCP (ADR-033) : les outils du catalogue du pair indexeur (tools.list), ceux
// que l'agent du jeton a le droit d'utiliser. Un jeton sans agent garde la
// lecture seule. Chaque appel est verifie ici (agent, vault, mode), puis
// execute par le pair avec un ticket d'ecriture ; « demander » met l'appel en
// attente de l'accord de la personne, dans Savoire.

use axum::extract::{Path, Query, State};
use axum::http::{HeaderValue, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::{ReqParts, indexer_rate, ok, public_base, raw_json_ok, reply, status};
use crate::api::indexer::call_indexer;
use crate::api::agents;
use crate::auth::{OpenAuth, Principal};
use crate::db::agents::AgentRow;
use crate::error::{AppError, AppResult};
use crate::services::indexer::{IndexerReply, codes};
use crate::state::AppState;

pub const MAX_LIMIT: i64 = 50;

struct OpenVault {
    id: String,
    name: String,
    role: String,
}

fn allows(p: &Principal, vault_id: &str) -> bool {
    p.token_vaults.as_ref().is_none_or(|v| v.iter().any(|x| x == vault_id))
}

fn forbidden_vault() -> IndexerReply {
    IndexerReply::error(403, "forbidden_vault", "Ce jeton ne donne pas acces a ce vault.", None)
}

async fn vaults(st: &AppState, p: &Principal) -> AppResult<Vec<OpenVault>> {
    let ws = crate::api::vaults::workspace(st, &p.sub).await?;
    Ok(ws.vaults.into_iter().filter(|v| allows(p, &v.id)).map(|v| OpenVault { id: v.id, name: v.name, role: v.role }).collect())
}

async fn resolve_vault(st: &AppState, p: &Principal, id_or_name: &str) -> AppResult<Option<OpenVault>> {
    let list = vaults(st, p).await?;
    let pos = list.iter().position(|v| v.id == id_or_name).or_else(|| list.iter().position(|v| v.name.to_lowercase() == id_or_name.to_lowercase()));
    Ok(pos.map(|i| list.into_iter().nth(i).unwrap()))
}

async fn call(st: &AppState, p: &Principal, vault_id: &str, capability: &str, method: &str, params: Value) -> AppResult<IndexerReply> {
    if !allows(p, vault_id) {
        return Ok(forbidden_vault());
    }
    call_indexer(st, &p.sub, vault_id, capability, method, &params).await
}

fn clamp(limit: Option<i64>, fallback: i64) -> i64 {
    limit.unwrap_or(fallback).clamp(1, MAX_LIMIT)
}

async fn search(st: &AppState, p: &Principal, vault_id: &str, text: &str, limit: Option<i64>, folder: Option<&str>) -> AppResult<IndexerReply> {
    let mut params = json!({ "text": text, "limit": clamp(limit, 10) });
    if let Some(f) = folder.filter(|f| !f.is_empty()) {
        params["folder"] = json!(f);
    }
    call(st, p, vault_id, "search", "run", params).await
}

async fn list_notes(st: &AppState, p: &Principal, vault_id: &str, folder: Option<&str>, limit: Option<i64>, cursor: Option<&str>) -> AppResult<IndexerReply> {
    let mut from = json!({ "notes": true });
    if let Some(f) = folder.filter(|f| !f.is_empty()) {
        from["folder"] = json!(f);
    }
    let mut params = json!({ "from": from, "sort": [{ "field": { "doc": "path" } }], "limit": clamp(limit, MAX_LIMIT) });
    if let Some(c) = cursor.filter(|c| !c.is_empty()) {
        params["cursor"] = json!(c);
    }
    call(st, p, vault_id, "query", "run", params).await
}

async fn read(st: &AppState, p: &Principal, vault_id: &str, id: Option<&str>, path: Option<&str>) -> AppResult<IndexerReply> {
    let params = match id.filter(|i| !i.is_empty()) {
        Some(i) => json!({ "id": i }),
        None => json!({ "path": path.unwrap_or("") }),
    };
    call(st, p, vault_id, "documents", "read", params).await
}

fn error_message(r: &IndexerReply) -> String {
    serde_json::from_str::<Value>(&r.json)
        .ok()
        .and_then(|v| v.get("error")?.get("message")?.as_str().map(str::to_string))
        .unwrap_or_else(|| format!("Erreur {}.", r.status))
}

// ── REST ─────────────────────────────────────────────────────────────────────

pub async fn description(State(st): State<AppState>, ReqParts(parts): ReqParts) -> Response {
    let yaml = include_str!("../../assets/open-api.yaml").replace("{{SERVER}}", &public_base(&st, &parts));
    let mut r = yaml.into_response();
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/yaml; charset=utf-8"));
    r
}

pub async fn rest_vaults(State(st): State<AppState>, OpenAuth(p): OpenAuth) -> AppResult<Response> {
    if let Err(r) = indexer_rate(&st, &p.sub, None) {
        return Ok(r);
    }
    let list: Vec<Value> = vaults(&st, &p).await?.into_iter().map(|v| json!({ "id": v.id, "name": v.name, "role": v.role })).collect();
    Ok(ok(&json!({ "vaults": list })))
}

#[derive(Deserialize)]
pub struct SearchRequest {
    text: Option<String>,
    limit: Option<i64>,
    folder: Option<String>,
}

pub async fn rest_search(State(st): State<AppState>, OpenAuth(p): OpenAuth, Path(vault_id): Path<String>, super::Body(req): super::Body<SearchRequest>) -> AppResult<Response> {
    if let Err(r) = indexer_rate(&st, &p.sub, Some(&vault_id)) {
        return Ok(r);
    }
    Ok(reply(search(&st, &p, &vault_id, req.text.as_deref().unwrap_or(""), req.limit, req.folder.as_deref()).await?))
}

#[derive(Deserialize)]
pub struct NotesQuery {
    folder: Option<String>,
    limit: Option<i64>,
    cursor: Option<String>,
    path: Option<String>,
    id: Option<String>,
}

pub async fn rest_notes(State(st): State<AppState>, OpenAuth(p): OpenAuth, Path(vault_id): Path<String>, Query(q): Query<NotesQuery>) -> AppResult<Response> {
    if let Err(r) = indexer_rate(&st, &p.sub, Some(&vault_id)) {
        return Ok(r);
    }
    Ok(reply(list_notes(&st, &p, &vault_id, q.folder.as_deref(), q.limit, q.cursor.as_deref()).await?))
}

pub async fn rest_read(State(st): State<AppState>, OpenAuth(p): OpenAuth, Path(vault_id): Path<String>, Query(q): Query<NotesQuery>) -> AppResult<Response> {
    if let Err(r) = indexer_rate(&st, &p.sub, Some(&vault_id)) {
        return Ok(r);
    }
    if q.path.as_deref().unwrap_or("").is_empty() && q.id.as_deref().unwrap_or("").is_empty() {
        return Ok(reply(IndexerReply::error(400, codes::INVALID_QUERY, "Donner path ou id.", None)));
    }
    Ok(reply(read(&st, &p, &vault_id, q.id.as_deref(), q.path.as_deref()).await?))
}

pub const MAX_QUERY_BYTES: usize = 64 * 1024;

pub async fn rest_query(State(st): State<AppState>, OpenAuth(p): OpenAuth, Path(vault_id): Path<String>, body: axum::body::Bytes) -> AppResult<Response> {
    if let Err(r) = indexer_rate(&st, &p.sub, Some(&vault_id)) {
        return Ok(r);
    }
    let parsed: Value = serde_json::from_slice(&body).map_err(|_| AppError::validation("Corps JSON invalide."))?;
    if !parsed.is_object() {
        return Ok(reply(IndexerReply::error(400, codes::INVALID_QUERY, "Objet JSON attendu.", None)));
    }
    Ok(reply(call(&st, &p, &vault_id, "query", "run", parsed).await?))
}

// ── MCP ──────────────────────────────────────────────────────────────────────

pub const LATEST_PROTOCOL: &str = "2025-06-18";
const PROTOCOLS: [&str; 3] = [LATEST_PROTOCOL, "2025-03-26", "2024-11-05"];
const INSTRUCTIONS: &str = "Savoire : les notes Markdown de la personne, rangees dans des vaults. \
Commencez par list_vaults, puis search pour trouver des notes et read_note pour les lire. \
Un vault se designe par son id ou par son nom (parametre vault de chaque outil). \
Ne relisez pas une note entiere : read_note sait rendre une section (section), des lignes (lines), \
ou seulement ce qui a change depuis votre lecture (since) ; un PDF, meme tres gros, se lit par pages (pages, ex. 120-135). \
Un fichier (bibliotheque, donnees, PDF...) se range avec add_file : par adresse https (url), \
ou, depuis un terminal, envoye d'abord a l'adresse donnee par file_upload_url (upload). \
Pour ecrire, ne reecrivez pas la note : patch_note retouche un bloc par sa reference (entre ‹ › dans read_note). \
Les dessins Excalidraw (.excalidraw) ne sont pas des notes : ils se lisent et s'ecrivent avec les outils drawing_* \
(drawing_create, drawing_diagram, drawing_add...), jamais en ecrivant leur JSON dans une note. \
Une presentation est une note avec la propriete type: slides : les diapositives sont separees par une ligne --- \
precedee d'une ligne vide, une ligne « Notes : » ouvre les notes du presentateur, un titre # en tete fait une diapositive de titre, \
une ligne « . . . » fait apparaitre la suite au clic. slides_outline donne son plan ; slides_style regle son allure \
(transitions, points des listes un par un, decor, couleur ou image de fond), pour toute la presentation ou une diapositive. \
Les animations (.anim, anime.js) se font avec les outils animation_* (animation_create, animation_update...) \
et se montrent dans une note ou une diapositive avec animation_embed. \
Vous agissez sous le nom d'un agent, avec ses droits : une action refusee ou en attente de validation ne se refait pas. \
Pour passer de l'edition (modifications directes) a la revision (propositions dans Revision), ou l'inverse : request_mode, avec l'accord de la personne. \
Quand la personne dit « ici », « ce passage », « ca » ou « la selection », appelez get_context : il rend la note ouverte (ou le PDF ouvert, sa page), sa selection et ses surlignages. \
Quand elle parle d'une demande ou d'un commentaire qu'elle vous a laisse dans une note, appelez list_requests, n'agissez que sur le passage vise, \
puis repondez dans le fil avec reply : la demande est close, ne la traitez pas deux fois. \
Commentaires : peu et courts (une ou deux phrases), de preference un seul, dans la marge du passage. \
N'ecrivez jamais dans le paragraphe ou la personne est en train d'ecrire : si un outil le refuse, attendez ou proposez (propose: true).";
pub const MAX_MCP_BYTES: usize = 256 * 1024;

pub fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn rpc_result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

pub async fn mcp_post(State(st): State<AppState>, OpenAuth(p): OpenAuth, ReqParts(parts): ReqParts, body: axum::body::Bytes) -> AppResult<Response> {
    if let Err(r) = indexer_rate(&st, &p.sub, None) {
        return Ok(r);
    }
    let message: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return Ok(raw_json_ok(rpc_error(Value::Null, -32700, "JSON invalide."))),
    };
    // L'adresse publique de Savoire : celle des envois de fichiers (file_upload_url).
    let base = public_base(&st, &parts);
    Ok(match handle(&st, &p, message, &base).await {
        Some(reply) => raw_json_ok(reply),
        None => status(202),
    })
}

pub async fn mcp_other() -> Response {
    status(405)
}

/// Un message JSON-RPC ; None : notification ou reponse du client (rien a rendre).
pub async fn handle(st: &AppState, p: &Principal, message: Value, base: &str) -> Option<Value> {
    let Some(msg) = message.as_object().filter(|m| m.get("jsonrpc").and_then(Value::as_str) == Some("2.0")) else {
        return Some(rpc_error(Value::Null, -32600, "Requete JSON-RPC 2.0 attendue (un seul message, pas de lot)."));
    };
    let id = msg.get("id").cloned().unwrap_or(Value::Null);
    let method = msg.get("method").and_then(Value::as_str)?;
    if !msg.contains_key("id") {
        return None;
    }
    let params = msg.get("params").and_then(Value::as_object).cloned();
    Some(match method {
        "initialize" => {
            let asked = params.as_ref().and_then(|p| p.get("protocolVersion")).and_then(Value::as_str);
            let version = asked.filter(|a| PROTOCOLS.contains(a)).unwrap_or(LATEST_PROTOCOL);
            rpc_result(id, json!({
                "protocolVersion": version,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "savoire", "title": "Savoire", "version": "0.1.0" },
                "instructions": INSTRUCTIONS,
            }))
        }
        "ping" => rpc_result(id, json!({})),
        "tools/list" => rpc_result(id, json!({ "tools": list_tools(st, p).await })),
        "tools/call" => match call_tool(st, p, params, base).await {
            Ok(r) => rpc_result(id, r),
            Err(InvalidParams(m)) => rpc_error(id, -32602, &m),
        },
        "resources/list" => rpc_result(id, json!({ "resources": [] })),
        "prompts/list" => rpc_result(id, json!({ "prompts": [] })),
        other => rpc_error(id, -32601, &format!("Methode inconnue : {other}.")),
    })
}

fn tool(name: &str, title: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({
        "name": name, "title": title, "description": description,
        "inputSchema": { "type": "object", "properties": properties, "required": required, "additionalProperties": false },
        "annotations": { "readOnlyHint": true, "openWorldHint": false },
    })
}

fn s(d: &str) -> Value {
    json!({ "type": "string", "description": d })
}

fn i(d: &str) -> Value {
    json!({ "type": "integer", "description": d })
}

fn tools() -> Value {
    json!([
        tool("list_vaults", "Vaults de Savoire", "Liste les vaults (espaces de notes) accessibles, avec leur id et leur nom.", json!({}), &[]),
        tool("search", "Chercher dans un vault", "Recherche plein texte dans les notes et fichiers d'un vault. Rend les notes trouvees, avec un extrait.",
            json!({ "vault": s("Id ou nom du vault."), "query": s("Mots a chercher. Guillemets pour une expression exacte."),
                    "limit": i("Nombre de resultats (1 a 50, defaut 10)."), "folder": s("Limiter a un dossier (ex. Projets/2026).") }),
            &["vault", "query"]),
        tool("list_notes", "Lister les notes", "Liste les notes d'un vault (ou d'un dossier), par chemin.",
            json!({ "vault": s("Id ou nom du vault."), "folder": s("Dossier (facultatif)."),
                    "limit": i("Nombre de notes (1 a 50, defaut 50)."), "cursor": s("Suite d'une liste precedente (champ next).") }),
            &["vault"]),
        tool("read_note", "Lire une note", "Rend le texte complet d'une note en Markdown (ou le texte d'un fichier), par son chemin ou son id.",
            json!({ "vault": s("Id ou nom du vault."), "path": s("Chemin de la note (ex. Projets/Plan.md)."), "id": s("Id de la note (rendu par search ou list_notes).") }),
            &["vault"]),
    ])
}

// ── Outils des agents (ADR-033) ──────────────────────────────────────────────

/// L'agent que porte le jeton ; sans agent (ou agent supprime), lecture seule.
async fn token_agent(st: &AppState, p: &Principal) -> AppResult<AgentRow> {
    if let Some(id) = &p.token_agent {
        let mut c = st.db.acquire().await?;
        if let Some(a) = crate::db::agents::get(&mut c, id).await?
            && agents::can_use(&mut c, &p.sub, &a).await?
        {
            return Ok(a);
        }
    }
    let at = crate::domain::now();
    Ok(AgentRow { id: "api-token".into(), owner_id: p.sub.clone(), vault_id: None, name: "Jeton API".into(), definition: agents::read_only_definition(), created_at: at, updated_at: at })
}

/// Un vault ou demander le catalogue au pair : le premier accessible a l'agent.
async fn catalog_for(st: &AppState, p: &Principal, agent: &AgentRow) -> Vec<Value> {
    let Ok(list) = vaults(st, p).await else { return vec![] };
    for v in list.iter().filter(|v| agents::vault_in_scope(&agent.definition, &v.id)) {
        if let Ok(cat) = agents::catalog(st, &p.sub, &v.id).await
            && !cat.is_empty()
        {
            return cat;
        }
    }
    vec![]
}

/// Les outils de l'agent : list_vaults, puis ceux du catalogue qu'il a le droit d'utiliser.
async fn list_tools(st: &AppState, p: &Principal) -> Value {
    let Ok(agent) = token_agent(st, p).await else { return tools() };
    let modes = mode_tools(p, &agent);
    let cat = catalog_for(st, p, &agent).await;
    // Contexte de l'editeur (get_context, list_pins) : servi ici, avec ou sans catalogue.
    let context = if agents::mode_for(&agent.definition, "read") == "deny" { vec![] } else { super::editor_context::mcp_tools() };
    if cat.is_empty() {
        let mut out = tools().as_array().cloned().unwrap_or_default();
        out.extend(modes);
        out.extend(context);
        return json!(out);
    }
    let mut out = vec![tools()[0].clone()];
    out.extend(context);
    for t in cat {
        let action = t.get("action").and_then(Value::as_str).unwrap_or("read");
        if agents::mode_for(&agent.definition, action) == "deny" {
            continue;
        }
        let mut schema = t.get("inputSchema").cloned().unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
        schema["properties"]["vault"] = s("Id ou nom du vault.");
        let mut required: Vec<Value> = schema.get("required").and_then(Value::as_array).cloned().unwrap_or_default();
        required.insert(0, json!("vault"));
        schema["required"] = json!(required);
        let name = t.get("name").and_then(Value::as_str).unwrap_or_default();
        let mut entry = json!({
            "name": name, "title": t.get("title"), "description": t.get("description"), "inputSchema": schema,
            "annotations": {
                "readOnlyHint": action == "read",
                "destructiveHint": action == "delete" || action == "organize",
                "openWorldHint": false,
            },
        });
        if name == ADD_IMAGE {
            image_tool_schema(&mut entry);
        }
        let file = name == ADD_FILE;
        if file {
            file_tool_schema(&mut entry);
        }
        out.push(entry);
        // L'envoi d'un fichier du poste (agents qui ont un terminal) : avec add_file.
        if file {
            out.push(upload_url_tool_entry());
        }
    }
    out.extend(modes);
    json!(out)
}

// ── Mode d'ecriture : edition ou revision (request_mode, get_mode) ────────────
//
// Outils du serveur, sans le pair. L'IA demande a changer de mode ; la
// personne accepte ou refuse dans Savoire (voir agents::request_mode).

pub const GET_MODE: &str = "get_mode";

/// get_mode pour tout agent ; request_mode s'il en a le droit (reglage de l'agent).
fn mode_tools(p: &Principal, agent: &AgentRow) -> Vec<Value> {
    if p.token_agent.as_deref() != Some(agent.id.as_str()) {
        return vec![];
    }
    let mut out = vec![tool(GET_MODE, "Mode de l'agent", "Dit le mode de l'agent : édition (modifications directes), révision (propositions dans Révision) ou demander avant d'écrire.",
        json!({ "vault": s("Id ou nom du vault (facultatif) : les modes bornés par les droits de la personne dans ce vault.") }), &[])];
    if agents::can_request_mode(&agent.definition) {
        let mut t = tool(agents::REQUEST_MODE, "Changer de mode",
            "Demande à passer en mode édition (direct : vos modifications s'appliquent) ou révision (propose : elles deviennent des propositions dans Révision). \
La personne accepte ou refuse dans Savoire ; la demande reste en attente, ne la refaites pas.",
            json!({ "mode": { "type": "string", "enum": ["direct", "propose"], "description": "direct : édition ; propose : révision." },
                    "reason": s("Pourquoi changer de mode, en une phrase (montré à la personne).") }),
            &["mode", "reason"]);
        t["annotations"] = json!({ "readOnlyHint": false, "destructiveHint": false, "openWorldHint": false });
        out.push(t);
    }
    out
}

/// L'agent du jeton ; None : jeton sans agent (lecture seule).
async fn own_agent(st: &AppState, p: &Principal) -> AppResult<Option<AgentRow>> {
    let a = token_agent(st, p).await?;
    Ok((p.token_agent.as_deref() == Some(a.id.as_str())).then_some(a))
}

async fn request_mode_tool(st: &AppState, p: &Principal, args: &Map<String, Value>) -> Result<Value, ToolFailure> {
    let Some(agent) = own_agent(st, p).await? else { return Ok(tool_error("Ce jeton n'a pas d'agent : il ne fait que lire.")) };
    let mode = opt_str(args, "mode").ok_or_else(|| ToolFailure::Invalid("Argument manquant : mode (direct ou propose).".into()))?;
    let r = agents::request_mode(st, &p.sub, &agent, &mode, &opt_str(args, "reason").unwrap_or_default()).await?;
    Ok(if r.is_error { tool_error(&r.text) } else { tool_text(&r.text) })
}

async fn get_mode_tool(st: &AppState, p: &Principal, args: &Map<String, Value>) -> Result<Value, ToolFailure> {
    let Some(agent) = own_agent(st, p).await? else { return Ok(tool_text("Jeton sans agent : lecture seule.")) };
    let vault = match opt_str(args, "vault") {
        Some(_) => Some(vault_arg(st, p, args).await?),
        None => None,
    };
    let mut c = st.db.acquire().await.map_err(AppError::from)?;
    let can_write = match &vault {
        Some(v) => Some(crate::access::require_write(&mut c, &p.sub, &v.id).await.is_ok()),
        None => None,
    };
    let pending = crate::db::agents::approval_pending(&mut c, &p.sub, &agent.id, agents::REQUEST_MODE).await?;
    Ok(tool_text(&agents::describe_mode(&agent, can_write, pending.as_ref().map(|a| a.id.as_str()))))
}

// ── Images (add_image) ───────────────────────────────────────────────────────
//
// Le pair ne recoit pas d'octets : le serveur telecharge l'image, la verifie,
// la range sous un id neuf, puis passe cet id a l'outil (fileId). ChatGPT
// donne un fichier joint a la discussion (champ « image », declare dans
// _meta « openai/fileParams ») ; une autre IA peut donner une adresse (« url »).

pub const ADD_IMAGE: &str = "add_image";

/// Le schema vu par l'IA : image (fichier) ou url, a la place de fileId.
fn image_tool_schema(entry: &mut Value) {
    let schema = &mut entry["inputSchema"];
    if let Some(props) = schema["properties"].as_object_mut() {
        props.remove("fileId");
        props.insert("image".into(), json!({
            "type": "object",
            "description": "L'image jointe à la discussion.",
            "properties": {
                "download_url": { "type": "string" }, "file_id": { "type": "string" },
                "mime_type": { "type": "string" }, "file_name": { "type": "string" },
            },
            "required": ["download_url", "file_id"],
        }));
        props.insert("url".into(), s("Ou : adresse https d'une image publique (si l'image n'est pas jointe)."));
    }
    schema["required"] = json!(["vault"]);
    entry["description"] = json!(format!("{} Donner image (fichier joint) ou url. PNG, JPEG, GIF, WebP ou AVIF, 20 Mo au plus.", entry["description"].as_str().unwrap_or("")));
    entry["_meta"] = json!({ "openai/fileParams": ["image"] });
    entry["annotations"]["openWorldHint"] = json!(true);
}

/// Telecharge l'image de l'appel, la range sous un id neuf ; rend les arguments pour le pair.
async fn receive_image(st: &AppState, vault_id: &str, args: &Map<String, Value>) -> Result<(Map<String, Value>, String, i64), Value> {
    let file = args.get("image").and_then(Value::as_object);
    let url = file.and_then(|f| f.get("download_url")).and_then(Value::as_str).map(str::to_string).or_else(|| opt_str(args, "url"));
    let Some(url) = url else {
        return Err(tool_error("Donner l'image : image (fichier joint) ou url (adresse https)."));
    };
    let img = crate::services::remote_image::fetch(&url).await.map_err(|m| tool_error(&m))?;
    let size = img.bytes.len() as i64;
    if st.quota.ensure_room(&st.limits(), vault_id, size).await.is_err() {
        return Err(tool_error("Plus de place dans ce vault pour cette image."));
    }
    let id = uuid::Uuid::new_v4().to_string();
    if let Err(e) = st.store.put(vault_id, &id, &img.bytes).await {
        tracing::error!(error = %e, "MCP : image non rangee");
        return Err(tool_error("Erreur interne de Savoire."));
    }
    st.quota.added(vault_id, size);
    let given = opt_str(args, "fileName").or_else(|| file.and_then(|f| f.get("file_name")).and_then(Value::as_str).map(str::to_string)).or(img.url_name);
    let stem = given.as_deref().map(|n| n.rsplit_once('.').map(|(a, _)| a).unwrap_or(n).trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| "Image".into());
    let mut out = args.clone();
    for k in ["vault", "image", "url", "fileId", "fileName"] {
        out.remove(k);
    }
    out.insert("fileId".into(), json!(id));
    out.insert("fileName".into(), json!(format!("{stem}.{}", img.ext)));
    Ok((out, id, size))
}

/// L'image n'a pas ete inscrite (refus, echec) : on rend la place.
pub async fn drop_received_image(st: &AppState, vault_id: &str, args: &Value) {
    let Some(id) = args.get("fileId").and_then(Value::as_str) else { return };
    if !FILE_ID_SHAPE.is_match(id) {
        return;
    }
    let Ok(mut c) = st.db.acquire().await else { return };
    // Inscrite entre-temps : c'est un document du vault, on n'y touche pas.
    if !matches!(crate::db::repos::doc_get(&mut c, id).await, Ok(None)) {
        return;
    }
    if let Ok(Some(f)) = st.store.read(vault_id, id).await
        && let Ok(meta) = f.metadata().await
    {
        st.quota.added(vault_id, -(meta.len() as i64));
    }
    let _ = st.store.delete(vault_id, id).await;
}

// ── Fichiers (add_file, file_upload_url) ─────────────────────────────────────
//
// Comme add_image, pour tout fichier (bibliotheque, donnees, document...) : le
// pair ne recoit jamais d'octets. Trois facons de donner le fichier :
//  - file : un fichier joint a la discussion (ChatGPT) ;
//  - url : une adresse https publique (memes protections que les images) ;
//  - upload : un envoi fait avant par file_upload_url. L'IA (ou son terminal)
//    envoie les octets par PUT a une adresse a usage unique, valable 15 min,
//    liee a la personne et au vault ; ils ne passent jamais par la discussion.

pub const ADD_FILE: &str = "add_file";
pub const FILE_UPLOAD_URL: &str = "file_upload_url";
/// Taille maximale d'un fichier recu d'une IA.
pub const MAX_AGENT_FILE_BYTES: usize = 100 * 1024 * 1024;
const UPLOAD_TTL: std::time::Duration = std::time::Duration::from_secs(15 * 60);
/// Envois en attente au plus, par personne.
const MAX_UPLOAD_SLOTS: usize = 50;

/// Un envoi en attente : la place reservee, puis le fichier recu.
pub struct UploadSlot {
    user: String,
    vault_id: String,
    expires: std::time::Instant,
    /// Les octets recus, ranges sous cet id (pas encore un document).
    file_id: Option<String>,
    size: i64,
}

fn file_tool_schema(entry: &mut Value) {
    let schema = &mut entry["inputSchema"];
    if let Some(props) = schema["properties"].as_object_mut() {
        props.remove("fileId");
        props.insert("file".into(), json!({
            "type": "object",
            "description": "Le fichier joint à la discussion.",
            "properties": {
                "download_url": { "type": "string" }, "file_id": { "type": "string" },
                "mime_type": { "type": "string" }, "file_name": { "type": "string" },
            },
            "required": ["download_url", "file_id"],
        }));
        props.insert("url".into(), s("Ou : adresse https publique du fichier."));
        props.insert("upload".into(), s("Ou : le jeton d'un envoi fait avec file_upload_url (fichier du poste, sans passer par la discussion)."));
    }
    schema["required"] = json!(["vault", "path"]);
    entry["description"] = json!(format!("{} Donner file (fichier joint), url ou upload. 100 Mo au plus.", entry["description"].as_str().unwrap_or("")));
    entry["_meta"] = json!({ "openai/fileParams": ["file"] });
    entry["annotations"]["openWorldHint"] = json!(true);
}

fn upload_url_tool_entry() -> Value {
    let mut t = tool(
        FILE_UPLOAD_URL,
        "Adresse d'envoi d'un fichier",
        "Donne une adresse à usage unique (15 minutes) pour envoyer un fichier du poste, par PUT, sans le faire passer par la discussion : \
`curl -T fichier.pdf <adresse>`. Puis add_file avec upload = le jeton rendu. 100 Mo au plus. Pour les agents qui ont un terminal.",
        json!({ "vault": s("Id ou nom du vault où le fichier sera rangé.") }),
        &["vault"],
    );
    t["annotations"] = json!({ "readOnlyHint": false, "destructiveHint": false, "openWorldHint": false });
    t
}

/// Rend la place d'un envoi jamais inscrit (expire, ou abandonne).
async fn drop_slot(st: &AppState, slot: &UploadSlot) {
    let Some(id) = &slot.file_id else { return };
    let Ok(mut c) = st.db.acquire().await else { return };
    if !matches!(crate::db::repos::doc_get(&mut c, id).await, Ok(None)) {
        return;
    }
    st.quota.added(&slot.vault_id, -slot.size);
    let _ = st.store.delete(&slot.vault_id, id).await;
}

async fn sweep_slots(st: &AppState) {
    let now = std::time::Instant::now();
    let expired: Vec<String> = st.upload_slots.iter().filter(|e| e.expires <= now).map(|e| e.key().clone()).collect();
    for k in expired {
        if let Some((_, slot)) = st.upload_slots.remove(&k) {
            drop_slot(st, &slot).await;
        }
    }
}

async fn upload_url_tool(st: &AppState, p: &Principal, args: &Map<String, Value>, base: &str) -> Result<Value, ToolFailure> {
    let Some(agent) = own_agent(st, p).await? else { return Ok(tool_error("Ce jeton n'a pas d'agent : il ne fait que lire.")) };
    if agents::mode_for(&agent.definition, "create") == "deny" {
        return Ok(tool_error("Cet agent n'a pas le droit d'ajouter des fichiers."));
    }
    let vault = vault_arg(st, p, args).await?;
    sweep_slots(st).await;
    if st.upload_slots.iter().filter(|e| e.user == p.sub).count() >= MAX_UPLOAD_SLOTS {
        return Ok(tool_error("Trop d'envois en attente : inscrivez-les avec add_file, ou attendez qu'ils expirent."));
    }
    let token = {
        use rand::Rng;
        let bytes: [u8; 24] = rand::rng().random();
        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
    };
    st.upload_slots.insert(token.clone(), UploadSlot { user: p.sub.clone(), vault_id: vault.id.clone(), expires: std::time::Instant::now() + UPLOAD_TTL, file_id: None, size: 0 });
    let url = format!("{base}/api/open/v1/uploads/{token}");
    let mut out = tool_text(&format!(
        "Adresse d'envoi (15 minutes, une seule fois) : {url}\nEnvoyer le fichier par PUT, par exemple : curl -sS -T \"chemin/du/fichier\" \"{url}\"\nPuis : add_file avec upload = {token} et path = le chemin voulu dans le vault."
    ));
    out["structuredContent"] = json!({ "url": url, "upload": token, "expiresInSeconds": UPLOAD_TTL.as_secs() });
    Ok(out)
}

/// PUT /api/open/v1/uploads/{token} : les octets d'un envoi (le jeton suffit).
pub async fn upload_put(State(st): State<AppState>, Path(token): Path<String>, body: axum::body::Bytes) -> AppResult<Response> {
    let bad = |code: u16, m: &str| crate::error::raw_json(code, json!({ "error": m }).to_string());
    if !token.chars().all(|c| c.is_ascii_hexdigit()) || token.len() != 48 {
        return Ok(bad(404, "Envoi inconnu."));
    }
    let (vault_id, expired, used) = match st.upload_slots.get(&token) {
        Some(s) => (s.vault_id.clone(), s.expires <= std::time::Instant::now(), s.file_id.is_some()),
        None => return Ok(bad(404, "Envoi inconnu ou expiré.")),
    };
    if expired {
        if let Some((_, slot)) = st.upload_slots.remove(&token) {
            drop_slot(&st, &slot).await;
        }
        return Ok(bad(410, "Envoi expiré : redemandez une adresse (file_upload_url)."));
    }
    if used {
        return Ok(bad(409, "Cet envoi a déjà reçu son fichier."));
    }
    if body.is_empty() {
        return Ok(bad(400, "Fichier vide."));
    }
    if body.len() > MAX_AGENT_FILE_BYTES {
        return Ok(bad(413, "Fichier trop lourd (100 Mo au plus)."));
    }
    let size = body.len() as i64;
    if st.quota.ensure_room(&st.limits(), &vault_id, size).await.is_err() {
        return Ok(bad(507, "Plus de place dans ce vault."));
    }
    let id = uuid::Uuid::new_v4().to_string();
    st.store.put(&vault_id, &id, &body).await?;
    st.quota.added(&vault_id, size);
    match st.upload_slots.get_mut(&token) {
        Some(mut slot) if slot.file_id.is_none() => {
            slot.file_id = Some(id);
            slot.size = size;
        }
        _ => {
            st.quota.added(&vault_id, -size);
            let _ = st.store.delete(&vault_id, &id).await;
            return Ok(bad(409, "Cet envoi a déjà reçu son fichier."));
        }
    }
    Ok(raw_json_ok(json!({ "upload": token, "bytes": size, "next": "add_file avec upload = ce jeton" })))
}

/// Le fichier de l'appel (joint, adresse ou envoi), range sous un id neuf ; rend les arguments pour le pair.
async fn receive_file(st: &AppState, user: &str, vault_id: &str, args: &Map<String, Value>) -> Result<(Map<String, Value>, String, i64), Value> {
    let path = opt_str(args, "path").unwrap_or_default();
    if path.trim().is_empty() {
        return Err(tool_error("Donner path : le chemin du fichier dans le vault (ex. Bibliothèques/maplibre-gl.js)."));
    }
    let (id, size) = if let Some(token) = opt_str(args, "upload") {
        let ok = st.upload_slots.get(&token).is_some_and(|s| s.user == user && s.vault_id == vault_id && s.file_id.is_some() && s.expires > std::time::Instant::now());
        if !ok {
            return Err(tool_error("Envoi inconnu, expiré, d'un autre vault, ou sans fichier : refaites file_upload_url puis le PUT."));
        }
        let (_, slot) = st.upload_slots.remove(&token).ok_or_else(|| tool_error("Envoi inconnu."))?;
        (slot.file_id.unwrap_or_default(), slot.size)
    } else {
        let file = args.get("file").and_then(Value::as_object);
        let url = file.and_then(|f| f.get("download_url")).and_then(Value::as_str).map(str::to_string).or_else(|| opt_str(args, "url"));
        let Some(url) = url else {
            return Err(tool_error("Donner le fichier : file (joint), url (adresse https) ou upload (file_upload_url)."));
        };
        let f = crate::services::remote_image::fetch_file(&url, MAX_AGENT_FILE_BYTES).await.map_err(|m| tool_error(&m))?;
        let size = f.bytes.len() as i64;
        if st.quota.ensure_room(&st.limits(), vault_id, size).await.is_err() {
            return Err(tool_error("Plus de place dans ce vault pour ce fichier."));
        }
        let id = uuid::Uuid::new_v4().to_string();
        if let Err(e) = st.store.put(vault_id, &id, &f.bytes).await {
            tracing::error!(error = %e, "MCP : fichier non range");
            return Err(tool_error("Erreur interne de Savoire."));
        }
        st.quota.added(vault_id, size);
        (id, size)
    };
    let mut out = args.clone();
    for k in ["vault", "file", "url", "upload", "fileId"] {
        out.remove(k);
    }
    out.insert("fileId".into(), json!(id));
    Ok((out, id, size))
}

pub(crate) static FILE_ID_SHAPE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"^[A-Za-z0-9-]{1,64}$").unwrap());

/// Un outil du catalogue. None : catalogue indisponible (l'appelant se rabat sur la lecture d'avant).
async fn agent_tool(st: &AppState, p: &Principal, name: &str, args: &Map<String, Value>) -> Result<Option<Value>, ToolFailure> {
    let agent = token_agent(st, p).await?;
    let vault = vault_arg(st, p, args).await?;
    let cat = agents::catalog(st, &p.sub, &vault.id).await?;
    if cat.is_empty() {
        return Ok(None);
    }
    let mut rest = args.clone();
    rest.remove("vault");
    let display = p.display_name.clone().unwrap_or_else(|| p.sub.clone());
    let plan = {
        let probe = Value::Object(rest.clone());
        let call = agents::ToolCall { user: &p.sub, display_name: &display, agent: &agent, vault_id: &vault.id, tool: name, args: &probe, approved: false };
        agents::plan(st, &call).await?
    };
    if let agents::Plan::Deny(m) = &plan {
        return Ok(Some(tool_error(m)));
    }
    // L'image d'abord (seulement si l'agent en a le droit) : l'accord eventuel porte sur une image deja recue.
    let image = if name == ADD_IMAGE || name == ADD_FILE {
        let received = if name == ADD_IMAGE { receive_image(st, &vault.id, &rest).await } else { receive_file(st, &p.sub, &vault.id, &rest).await };
        match received {
            Ok((a, _, _)) => {
                rest = a;
                true
            }
            Err(v) => return Ok(Some(v)),
        }
    } else {
        false
    };
    let rest = Value::Object(rest);
    let call = agents::ToolCall { user: &p.sub, display_name: &display, agent: &agent, vault_id: &vault.id, tool: name, args: &rest, approved: false };
    Ok(Some(match plan {
        agents::Plan::Deny(m) => tool_error(&m),
        agents::Plan::Ask { action } => {
            let id = agents::hold(st, &call, &action).await?;
            tool_text(&format!(
                "Action en attente de validation dans Savoire (accord {id}). Elle sera faite quand la personne l'acceptera, dans le panneau Agents > Activité. Ne la refaites pas."
            ))
        }
        agents::Plan::Run { action, mode } => {
            let r = agents::execute(st, &call, &action, &mode).await?;
            if r.is_error && image {
                drop_received_image(st, &vault.id, &rest).await;
            }
            if r.is_error { tool_error(&r.text) } else { tool_text(&r.text) }
        }
    }))
}

struct InvalidParams(String);

fn tool_text(text: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": false })
}

fn tool_error(text: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": true })
}

fn opt_str(args: &Map<String, Value>, key: &str) -> Option<String> {
    args.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

fn opt_int(args: &Map<String, Value>, key: &str) -> Option<i64> {
    let v = args.get(key)?;
    v.as_i64().or_else(|| v.as_f64().map(|f| f as i64))
}

/// Texte d'une valeur JSON comme JsonNode.ToString() : un texte sans guillemets, rien pour null.
fn node_text(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

async fn call_tool(st: &AppState, p: &Principal, params: Option<Map<String, Value>>, base: &str) -> Result<Value, InvalidParams> {
    let name = params
        .as_ref()
        .and_then(|p| p.get("name"))
        .and_then(Value::as_str)
        .ok_or_else(|| InvalidParams("Nom d'outil manquant.".into()))?
        .to_string();
    let args = params.as_ref().and_then(|p| p.get("arguments")).and_then(Value::as_object).cloned().unwrap_or_default();
    let r = match name.as_str() {
        "list_vaults" => list_vaults_tool(st, p).await,
        GET_MODE => get_mode_tool(st, p, &args).await,
        agents::REQUEST_MODE => request_mode_tool(st, p, &args).await,
        FILE_UPLOAD_URL => upload_url_tool(st, p, &args, base).await,
        n if super::editor_context::is_tool(n) => context_tool(st, p, n, &args).await,
        _ => match agent_tool(st, p, &name, &args).await {
            // Pas de catalogue (pair absent, ancien pair) : les outils de lecture d'avant.
            Ok(None) => match name.as_str() {
                "search" => search_tool(st, p, &args).await,
                "list_notes" => list_notes_tool(st, p, &args).await,
                "read_note" => read_note_tool(st, p, &args).await,
                other => return Err(InvalidParams(format!("Outil inconnu : {other}."))),
            },
            Ok(Some(v)) => Ok(v),
            Err(e) => Err(e),
        },
    };
    match r {
        Ok(v) => Ok(v),
        Err(ToolFailure::Invalid(m)) => Err(InvalidParams(m)),
        Err(ToolFailure::App(e)) => Ok(match &e {
            AppError::VaultNotFound(_) | AppError::DocumentNotInVault(_) | AppError::AccessDenied(_) | AppError::DocumentNotFound(_) => tool_error(&e.to_string()),
            _ => {
                tracing::error!(tool = %name, error = %e, "MCP : outil en erreur");
                tool_error("Erreur interne de Savoire.")
            }
        }),
    }
}

enum ToolFailure {
    Invalid(String),
    App(AppError),
}

impl From<AppError> for ToolFailure {
    fn from(e: AppError) -> Self {
        ToolFailure::App(e)
    }
}

async fn vault_arg(st: &AppState, p: &Principal, args: &Map<String, Value>) -> Result<OpenVault, ToolFailure> {
    let v = opt_str(args, "vault").ok_or_else(|| ToolFailure::Invalid("Argument manquant : vault.".into()))?;
    resolve_vault(st, p, &v).await?.ok_or(ToolFailure::App(AppError::VaultNotFound(v)))
}

async fn list_vaults_tool(st: &AppState, p: &Principal) -> Result<Value, ToolFailure> {
    let list = vaults(st, p).await?;
    if list.is_empty() {
        return Ok(tool_text("Aucun vault accessible avec ce jeton."));
    }
    let mut out = String::new();
    for v in list {
        out.push_str(&format!("- {} (id : {}, role : {})\n", v.name, v.id, v.role));
    }
    Ok(tool_text(&out))
}

/// Ou travaille la personne, ses epingles (api/editor_context.rs), pour l'agent du jeton.
async fn context_tool(st: &AppState, p: &Principal, name: &str, args: &Map<String, Value>) -> Result<Value, ToolFailure> {
    let agent = token_agent(st, p).await?;
    let list: Vec<(String, String)> = vaults(st, p).await?.into_iter().map(|v| (v.id, v.name)).collect();
    let r = super::editor_context::tool(st, &p.sub, &agent, &list, name, args).await?;
    let mut out = if r.is_error { tool_error(&r.text) } else { tool_text(&r.text) };
    if let Some(data) = r.data {
        out["structuredContent"] = data;
    }
    Ok(out)
}

async fn search_tool(st: &AppState, p: &Principal, args: &Map<String, Value>) -> Result<Value, ToolFailure> {
    let vault = vault_arg(st, p, args).await?;
    let query = opt_str(args, "query").ok_or_else(|| ToolFailure::Invalid("Argument manquant : query.".into()))?;
    let r = search(st, p, &vault.id, &query, opt_int(args, "limit"), opt_str(args, "folder").as_deref()).await?;
    if r.status != 200 {
        return Ok(tool_error(&error_message(&r)));
    }
    let result: Value = serde_json::from_str(&r.json).unwrap_or(Value::Null);
    let hits = result.get("hits").and_then(Value::as_array).cloned().unwrap_or_default();
    if hits.is_empty() {
        return Ok(tool_text(&format!("Aucun resultat pour « {query} » dans {}.", vault.name)));
    }
    let mut out = format!("{} resultat(s) dans {} :\n", hits.len(), vault.name);
    for h in &hits {
        out.push_str(&format!("- {} — {} (id : {})\n", node_text(h.get("title")), node_text(h.get("path")), node_text(h.get("id"))));
        if let Some(snippets) = h.get("snippets").and_then(Value::as_array) {
            for sn in snippets.iter().take(2) {
                out.push_str(&format!("  « {} »\n", node_text(sn.get("text"))));
            }
        }
    }
    Ok(tool_text(&out))
}

async fn list_notes_tool(st: &AppState, p: &Principal, args: &Map<String, Value>) -> Result<Value, ToolFailure> {
    let vault = vault_arg(st, p, args).await?;
    let r = list_notes(st, p, &vault.id, opt_str(args, "folder").as_deref(), opt_int(args, "limit"), opt_str(args, "cursor").as_deref()).await?;
    if r.status != 200 {
        return Ok(tool_error(&error_message(&r)));
    }
    let result: Value = serde_json::from_str(&r.json).unwrap_or(Value::Null);
    let mut out = format!("{} note(s) dans {} :\n", node_text(result.get("total")), vault.name);
    for row in result.get("rows").and_then(Value::as_array).cloned().unwrap_or_default() {
        out.push_str(&format!("- {} (id : {})\n", node_text(row.get("path")), node_text(row.get("id"))));
    }
    if let Some(next) = result.get("next").filter(|n| !n.is_null()) {
        out.push_str(&format!("Suite : cursor = {}\n", node_text(Some(next))));
    }
    Ok(tool_text(&out))
}

async fn read_note_tool(st: &AppState, p: &Principal, args: &Map<String, Value>) -> Result<Value, ToolFailure> {
    let vault = vault_arg(st, p, args).await?;
    let id = opt_str(args, "id");
    let path = opt_str(args, "path");
    if id.is_none() && path.is_none() {
        return Err(ToolFailure::Invalid("Donner path ou id.".into()));
    }
    let r = read(st, p, &vault.id, id.as_deref(), path.as_deref()).await?;
    if r.status != 200 {
        return Ok(tool_error(&error_message(&r)));
    }
    let doc: Value = serde_json::from_str(&r.json).unwrap_or(Value::Null);
    let mut text = format!("# {}\n\n{}", node_text(doc.get("path")), node_text(doc.get("content")));
    if doc.get("truncated").and_then(Value::as_bool) == Some(true) {
        text.push_str("\n\n[Texte tronque : note trop longue.]");
    }
    Ok(tool_text(&text))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_text_like_dotnet() {
        assert_eq!(node_text(Some(&json!("x"))), "x");
        assert_eq!(node_text(Some(&json!(3))), "3");
        assert_eq!(node_text(None), "");
        assert_eq!(node_text(Some(&Value::Null)), "");
    }

    #[test]
    fn tools_are_read_only() {
        let t = tools();
        let list = t.as_array().unwrap();
        assert_eq!(list.len(), 4);
        assert!(list.iter().all(|t| t["annotations"]["readOnlyHint"] == json!(true)));
    }

    #[test]
    fn token_vault_filter() {
        let mut p = Principal::default();
        assert!(allows(&p, "v"));
        p.token_vaults = Some(vec!["a".into()]);
        assert!(allows(&p, "a") && !allows(&p, "v"));
    }
}
