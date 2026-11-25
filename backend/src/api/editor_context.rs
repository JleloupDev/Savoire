// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le contexte de l'editeur, pour l'IA : quand la personne dit a ChatGPT ou a
// Claude « reformule ce passage » ou « ajoute ca ici », l'IA sait quelle note
// est ouverte dans Savoire, ce qui y est selectionne (ou ou est le curseur),
// et ce que la personne a marque pour elle.
//
// Trois choses :
//  - le CONTEXTE : l'application l'envoie a chaque selection ou deplacement
//    du curseur. Il reste en memoire, par personne : environ une minute
//    d'historique, plus la derniere entree (la personne est partie dans la
//    fenetre de ChatGPT). Rien en base. Plusieurs onglets ou appareils : le
//    dernier actif l'emporte ;
//  - les EPINGLES : un passage (ou un endroit) fige sous un nom, qui reste ;
//  - les SURLIGNAGES : des passages marques « pour l'IA », jusqu'a ce que la
//    personne les efface. Personnels, jamais ecrits dans la note.
// Epingles et surlignages sont en base (ai_marks).
//
// La FRAPPE : quand la personne tape, l'application joint `typingAt` (l'heure
// de sa derniere frappe) a l'entree, de temps en temps. Le serveur retient ou
// elle tapait ; un agent qui ecrit par MCP recoit cet endroit avec son appel
// (api/agents.rs, `typing`) et n'ecrit pas dans ce paragraphe tant que la
// frappe a moins de 8 s.
//
// Routes (compte connecte) :
//   POST   /api/v1/me/editor-context            ou je suis
//   GET    /api/v1/me/ai-marks?vaultId=&docId=&kind=
//   POST   /api/v1/me/ai-marks                  { vaultId, docId, kind, label, path, anchor }
//   PATCH  /api/v1/me/ai-marks/{id}             { label?, path?, anchor? }
//   DELETE /api/v1/me/ai-marks/{id}
//   DELETE /api/v1/me/ai-marks?vaultId=&docId=&kind=   effacer d'un coup
// Outils MCP (api/open.rs les sert) : get_context, list_pins.
//
// Seulement pour les vaults que le serveur lit : jamais pour un vault chiffre
// de bout en bout (le texte selectionne passerait en clair).
//
// L'ancre d'un passage (partagee avec les outils d'ecriture) :
//   { docId, start, end, quote, prefix, suffix }
// start / end : position relative Yjs (Y.encodeRelativePosition, en base64)
// dans le texte de la note ; quote : le texte ; prefix / suffix : 32
// caracteres au plus, juste avant et juste apres.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use axum::extract::{Path, Query, State};
use axum::response::Response;
use dashmap::DashMap;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use sqlx::PgConnection;

use super::{Body, no_content, ok};
use crate::access;
use crate::api::agents;
use crate::auth::Auth;
use crate::db::agents::AgentRow;
use crate::db::ai_marks::{self as db, AiMarkRow};
use crate::domain::{Ts, is_link_caller, new_id_n, now};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Ce que la memoire garde : une minute, et toujours la derniere entree.
pub const RING_SECONDS: u64 = 60;
const RING_MAX: usize = 64;
pub const MAX_SELECTION_CHARS: usize = 4000;
const MAX_AROUND_CHARS: usize = 300;
const MAX_ANCHOR_SIDE_CHARS: usize = 32;
const MAX_POSITION_CHARS: usize = 1024;
const MAX_HEADINGS: usize = 8;
const MAX_MARKS_PER_USER: i64 = 500;
/// Au-dela, l'IA demande a la personne de confirmer avant d'agir.
pub const STALE_SECONDS: u64 = 120;
pub const MAX_SECONDS_AGO: i64 = 3600;
/// Tant que la personne a tape il y a moins de ce delai, un agent n'ecrit pas dans son paragraphe.
pub const TYPING_GUARD_MS: u64 = 8000;
pub const MAX_BODY_KB: usize = 64;

// ── Le contexte, en memoire ──────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct ContextEntry {
    pub vault_id: String,
    pub doc_id: String,
    pub path: String,
    /// Texte selectionne ; vide : un curseur.
    pub selection: String,
    pub selection_truncated: bool,
    pub anchor: Value,
    /// Une dizaine de mots avant et apres.
    pub before: String,
    pub after: String,
    /// Les titres au-dessus du passage, du plus haut au plus proche.
    pub heading_path: Vec<String>,
    pub block_hash: String,
    /// Onglet ou appareil d'ou vient l'entree.
    pub tab_id: String,
    /// Heure de l'application (indicative : l'age se compte sur l'heure du serveur).
    pub client_at: Option<i64>,
    pub received: Instant,
    pub received_at: Ts,
}

/// Ou la personne a tape en dernier.
#[derive(Debug, Clone)]
pub struct TypingEntry {
    pub vault_id: String,
    pub doc_id: String,
    /// Empreinte du bloc ou elle tapait.
    pub block_hash: String,
    /// L'endroit du curseur (ancre de l'editeur).
    pub anchor: Value,
    /// Quand elle a tape, a l'horloge du serveur.
    pub typed: Instant,
}

#[derive(Default)]
pub struct ContextStore {
    users: DashMap<String, VecDeque<ContextEntry>>,
    typing: DashMap<String, TypingEntry>,
}

impl ContextStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Ajoute une entree (son heure : `e.received`) ; les anciennes sortent, sauf la derniere.
    pub fn push(&self, user: &str, e: ContextEntry) {
        let at = e.received;
        let mut ring = self.users.entry(user.to_string()).or_default();
        ring.push_back(e);
        while ring.len() > 1 && (ring.len() > RING_MAX || at.duration_since(ring[0].received) > Duration::from_secs(RING_SECONDS)) {
            ring.pop_front();
        }
    }

    /// Ou etait la personne il y a `seconds_ago` secondes : la derniere entree
    /// recue avant ce moment, sinon la plus ancienne gardee. Avec son age.
    pub fn at(&self, user: &str, seconds_ago: u64, now: Instant) -> Option<(ContextEntry, u64)> {
        let ring = self.users.get(user)?;
        let target = now.checked_sub(Duration::from_secs(seconds_ago));
        let found = target.and_then(|t| ring.iter().rev().find(|e| e.received <= t)).or_else(|| ring.front())?;
        Some((found.clone(), now.saturating_duration_since(found.received).as_secs()))
    }

    /// La personne a tape la (la derniere frappe l'emporte).
    pub fn typed(&self, user: &str, e: TypingEntry) {
        self.typing.insert(user.to_string(), e);
    }

    /// Ou elle tape en ce moment dans ce vault, et depuis combien de
    /// millisecondes. None : elle ne tape pas (ou plus depuis TYPING_GUARD_MS).
    pub fn typing(&self, user: &str, vault_id: &str, now: Instant) -> Option<(TypingEntry, u64)> {
        let e = self.typing.get(user)?;
        let age = now.saturating_duration_since(e.typed).as_millis() as u64;
        (e.vault_id == vault_id && age < TYPING_GUARD_MS).then(|| (e.clone(), age))
    }

    /// Le compte est supprime : plus rien de lui en memoire.
    pub fn forget(&self, user: &str) {
        self.users.remove(user);
        self.typing.remove(user);
    }
}

// ── Nettoyage de ce que l'application envoie ─────────────────────────────────

fn cut(s: &str, max: usize) -> (String, bool) {
    match s.char_indices().nth(max) {
        Some((i, _)) => (s[..i].to_string(), true),
        None => (s.to_string(), false),
    }
}

/// Les `max` derniers caracteres (ce qui precede un passage).
fn cut_start(s: &str, max: usize) -> String {
    let n = s.chars().count();
    if n <= max { s.to_string() } else { s.chars().skip(n - max).collect() }
}

fn text_of(o: &Map<String, Value>, key: &str) -> String {
    o.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

static POSITION_SHAPE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"^[A-Za-z0-9+/=_-]+$").unwrap());

/// Une ancre propre : les champs connus, bornes. Le document est celui de la requete.
fn clean_anchor(v: Option<&Value>, doc_id: &str) -> AppResult<Value> {
    let Some(o) = v.and_then(Value::as_object) else { return Err(AppError::validation("Ancre manquante (anchor).")) };
    let position = |key: &str| -> AppResult<String> {
        let p = text_of(o, key);
        if p.is_empty() || p.len() > MAX_POSITION_CHARS || !POSITION_SHAPE.is_match(&p) {
            return Err(AppError::validation(format!("Ancre invalide ({key}).")));
        }
        Ok(p)
    };
    Ok(json!({
        "docId": doc_id,
        "start": position("start")?,
        "end": position("end")?,
        "quote": cut(&text_of(o, "quote"), MAX_SELECTION_CHARS).0,
        "prefix": cut_start(&text_of(o, "prefix"), MAX_ANCHOR_SIDE_CHARS),
        "suffix": cut(&text_of(o, "suffix"), MAX_ANCHOR_SIDE_CHARS).0,
    }))
}

fn require_account(caller: &str) -> AppResult<()> {
    if is_link_caller(caller) {
        return Err(AppError::denied("Un lien de partage n'a pas de contexte pour l'IA."));
    }
    Ok(())
}

fn id_of(o: &Map<String, Value>, key: &str) -> AppResult<String> {
    let v = text_of(o, key);
    if v.is_empty() || v.len() > 200 {
        return Err(AppError::validation(format!("Champ manquant ou trop long : {key}.")));
    }
    Ok(v)
}

/// Un vault chiffre de bout en bout : le serveur n'y lit rien, on n'y envoie rien.
async fn is_end_to_end(c: &mut PgConnection, vault_id: &str) -> AppResult<bool> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM vault_key_wraps WHERE vault_id = $1) OR EXISTS(SELECT 1 FROM edgesync_blobs WHERE vault_id = $1)",
    )
    .bind(vault_id)
    .fetch_one(&mut *c)
    .await?)
}

/// La personne lit cette note, dans un vault que le serveur lit.
async fn require_readable(c: &mut PgConnection, user: &str, vault_id: &str, doc_id: &str) -> AppResult<()> {
    access::require_document_read(c, user, vault_id, doc_id).await?;
    if is_end_to_end(c, vault_id).await? {
        return Err(AppError::denied("Vault chiffré de bout en bout : rien n'est envoyé au serveur pour l'IA."));
    }
    Ok(())
}

// ── Routes ───────────────────────────────────────────────────────────────────

pub async fn publish(State(st): State<AppState>, Auth(p): Auth, Body(body): Body<Value>) -> AppResult<Response> {
    require_account(&p.sub)?;
    let Some(o) = body.as_object() else { return Err(AppError::validation("Objet JSON attendu.")) };
    let vault_id = id_of(o, "vaultId")?;
    let doc_id = id_of(o, "docId")?;
    let anchor = clean_anchor(o.get("anchor"), &doc_id)?;
    {
        let mut c = st.db.acquire().await?;
        require_readable(&mut c, &p.sub, &vault_id, &doc_id).await?;
    }
    let (selection, selection_truncated) = cut(&text_of(o, "selection"), MAX_SELECTION_CHARS);
    let heading_path = o
        .get("headingPath")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).take(MAX_HEADINGS).map(|h| cut(h, 200).0).collect())
        .unwrap_or_default();
    let received = Instant::now();
    let block_hash = cut(&text_of(o, "blockHash"), 32).0;
    let client_at = o.get("at").and_then(Value::as_i64);
    // Elle tapait ici : l'age de la frappe se compte a l'horloge de l'application
    // (at - typingAt), puis on le reporte sur celle du serveur.
    if let Some(typing_at) = o.get("typingAt").and_then(Value::as_i64) {
        let ago = client_at.map(|at| (at - typing_at).clamp(0, 60_000) as u64).unwrap_or(0);
        if let Some(typed) = received.checked_sub(Duration::from_millis(ago)) {
            st.editor_contexts.typed(&p.sub, TypingEntry { vault_id: vault_id.clone(), doc_id: doc_id.clone(), block_hash: block_hash.clone(), anchor: anchor.clone(), typed });
        }
    }
    st.editor_contexts.push(&p.sub, ContextEntry {
        vault_id,
        doc_id,
        path: cut(&text_of(o, "path"), 1024).0,
        selection,
        selection_truncated,
        anchor,
        before: cut_start(&text_of(o, "before"), MAX_AROUND_CHARS),
        after: cut(&text_of(o, "after"), MAX_AROUND_CHARS).0,
        heading_path,
        block_hash,
        tab_id: cut(&text_of(o, "tabId"), 64).0,
        client_at,
        received,
        received_at: now(),
    });
    Ok(no_content())
}

fn mark_dto(m: &AiMarkRow) -> Value {
    json!({ "id": m.id, "vaultId": m.vault_id, "docId": m.doc_id, "kind": m.kind, "label": m.label, "path": m.path, "anchor": m.anchor, "createdAt": m.created_at })
}

fn kind_of(raw: &str) -> AppResult<&'static str> {
    match raw {
        "pin" => Ok("pin"),
        "highlight" => Ok("highlight"),
        _ => Err(AppError::validation("kind : « pin » ou « highlight ».")),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarksQuery {
    vault_id: Option<String>,
    doc_id: Option<String>,
    kind: Option<String>,
}

impl MarksQuery {
    fn filters(&self) -> AppResult<(Option<&str>, Option<&str>, Option<&'static str>)> {
        fn some(v: &Option<String>) -> Option<&str> {
            v.as_deref().filter(|s| !s.is_empty())
        }
        let kind = match some(&self.kind) {
            Some(k) => Some(kind_of(k)?),
            None => None,
        };
        Ok((some(&self.vault_id), some(&self.doc_id), kind))
    }
}

pub async fn list_marks(State(st): State<AppState>, Auth(p): Auth, Query(q): Query<MarksQuery>) -> AppResult<Response> {
    require_account(&p.sub)?;
    let (vault, doc, kind) = q.filters()?;
    let mut c = st.db.acquire().await?;
    let list: Vec<Value> = db::list(&mut c, &p.sub, vault, doc, kind, MAX_MARKS_PER_USER).await?.iter().map(mark_dto).collect();
    Ok(ok(&json!({ "marks": list })))
}

pub async fn create_mark(State(st): State<AppState>, Auth(p): Auth, Body(body): Body<Value>) -> AppResult<Response> {
    require_account(&p.sub)?;
    let Some(o) = body.as_object() else { return Err(AppError::validation("Objet JSON attendu.")) };
    let vault_id = id_of(o, "vaultId")?;
    let doc_id = id_of(o, "docId")?;
    let kind = kind_of(&text_of(o, "kind"))?;
    let anchor = clean_anchor(o.get("anchor"), &doc_id)?;
    if kind == "highlight" && anchor["quote"].as_str().unwrap_or("").is_empty() {
        return Err(AppError::validation("Un surlignage porte sur un passage : sélectionnez du texte."));
    }
    let mut c = st.db.acquire().await?;
    require_readable(&mut c, &p.sub, &vault_id, &doc_id).await?;
    if db::count(&mut c, &p.sub).await? >= MAX_MARKS_PER_USER {
        return Err(AppError::validation("Trop d'épingles et de surlignages pour l'IA : effacez-en d'abord."));
    }
    let row = AiMarkRow {
        id: new_id_n(),
        user_id: p.sub.clone(),
        vault_id,
        doc_id,
        kind: kind.into(),
        label: cut(text_of(o, "label").trim(), 200).0,
        path: cut(&text_of(o, "path"), 1024).0,
        anchor,
        created_at: now(),
    };
    db::insert(&mut c, &row).await?;
    Ok(ok(&mark_dto(&row)))
}

pub async fn update_mark(State(st): State<AppState>, Auth(p): Auth, Path(id): Path<String>, Body(body): Body<Value>) -> AppResult<Response> {
    require_account(&p.sub)?;
    let Some(o) = body.as_object() else { return Err(AppError::validation("Objet JSON attendu.")) };
    let mut c = st.db.acquire().await?;
    let row = db::get(&mut c, &id).await?.filter(|m| m.user_id == p.sub).ok_or_else(|| AppError::DocumentNotFound(id.clone()))?;
    let anchor = match o.get("anchor") {
        Some(a) => Some(clean_anchor(Some(a), &row.doc_id)?),
        None => None,
    };
    let label = o.get("label").and_then(Value::as_str).map(|l| cut(l.trim(), 200).0);
    let path = o.get("path").and_then(Value::as_str).map(|l| cut(l, 1024).0);
    db::update(&mut c, &p.sub, &id, label.as_deref(), path.as_deref(), anchor.as_ref()).await?;
    Ok(no_content())
}

pub async fn delete_mark(State(st): State<AppState>, Auth(p): Auth, Path(id): Path<String>) -> AppResult<Response> {
    require_account(&p.sub)?;
    let mut c = st.db.acquire().await?;
    if !db::delete(&mut c, &p.sub, &id).await? {
        return Err(AppError::DocumentNotFound(id));
    }
    Ok(no_content())
}

pub async fn clear_marks(State(st): State<AppState>, Auth(p): Auth, Query(q): Query<MarksQuery>) -> AppResult<Response> {
    require_account(&p.sub)?;
    let (vault, doc, kind) = q.filters()?;
    let mut c = st.db.acquire().await?;
    let deleted = db::clear(&mut c, &p.sub, vault, doc, kind).await?;
    Ok(ok(&json!({ "deleted": deleted })))
}

// ── Outils MCP ───────────────────────────────────────────────────────────────

pub const GET_CONTEXT: &str = "get_context";
pub const LIST_PINS: &str = "list_pins";

pub fn is_tool(name: &str) -> bool {
    name == GET_CONTEXT || name == LIST_PINS
}

/// Les fiches des outils, telles que l'IA les voit.
pub fn mcp_tools() -> Vec<Value> {
    let entry = |name: &str, title: &str, description: &str, properties: Value| {
        json!({
            "name": name, "title": title, "description": description,
            "inputSchema": { "type": "object", "properties": properties, "required": [], "additionalProperties": false },
            "annotations": { "readOnlyHint": true, "openWorldHint": false },
        })
    };
    vec![
        entry(
            GET_CONTEXT,
            "Où travaille la personne",
            "Ce que la personne a sous les yeux dans Savoire : la note ouverte, le texte qu'elle a sélectionné (ou l'endroit du curseur), \
             la section, et les passages qu'elle a surlignés pour vous. Appelez-le de vous-même, avant de répondre ou d'agir, dès qu'elle dit \
             « ici », « ce passage », « ça », « cette phrase », « la sélection », « là où je suis », ou qu'elle demande de reformuler, \
             corriger ou compléter sans dire de quelle note elle parle. La sélection éclaire la demande ; ce n'est pas une vérité absolue : \
             si elle ne colle pas à ce qui est demandé, posez la question. L'ancre rendue désigne le passage pour les outils d'écriture.",
            json!({ "seconds_ago": { "type": "integer", "description":
                "Lire où était la personne il y a tant de secondes : le moment où elle a parlé, pas celui de l'appel (ex. 20). 0 ou absent : maintenant." } }),
        ),
        entry(
            LIST_PINS,
            "Épingles pour l'IA",
            "Les épingles que la personne a posées pour vous dans ses notes (« Épingler pour l'IA ») : un nom, la note, le passage et son ancre. \
             Appelez-le quand elle cite une épingle par son nom, ou parle de « l'endroit épinglé », « mes épingles ».",
            json!({ "vault": { "type": "string", "description": "Id ou nom du vault (facultatif : sinon, tous)." } }),
        ),
    ]
}

/// Le chemin est-il dans les dossiers de l'agent ? (copie de pathInScope, agent-core/policy.ts)
pub fn path_in_scope(definition: &Value, path: &str) -> bool {
    let trim = |s: &str| s.trim().trim_matches('/').to_string();
    let folders: Vec<String> = definition
        .get("scope")
        .and_then(|s| s.get("folders"))
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(trim).filter(|f| !f.is_empty()).collect())
        .unwrap_or_default();
    if folders.is_empty() {
        return true;
    }
    let p = trim(path);
    folders.iter().any(|f| p == *f || p.starts_with(&format!("{f}/")))
}

/// Ce que l'agent a le droit de voir : ses vaults, ses dossiers, et seulement en lecture permise.
struct Sight<'a> {
    user: &'a str,
    agent: &'a AgentRow,
    /// Les vaults de la personne que le jeton ouvre : (id, nom).
    vaults: &'a [(String, String)],
}

impl Sight<'_> {
    fn vault_name(&self, vault_id: &str) -> Option<&str> {
        self.vaults.iter().find(|(id, _)| id == vault_id).map(|(_, name)| name.as_str())
    }

    fn vault_visible(&self, vault_id: &str) -> bool {
        let def = &self.agent.definition;
        self.vault_name(vault_id).is_some()
            && agents::mode_for(def, "read") != "deny"
            && agents::vault_in_scope(def, vault_id)
            && self.agent.vault_id.as_deref().is_none_or(|v| v == vault_id)
    }

    /// La note : dans un vault visible, dans les dossiers de l'agent, et lisible par la personne.
    async fn sees(&self, c: &mut PgConnection, vault_id: &str, doc_id: &str, path: &str) -> AppResult<bool> {
        if !self.vault_visible(vault_id) || !path_in_scope(&self.agent.definition, path) {
            return Ok(false);
        }
        // Le dossier connu du serveur (ACL) compte aussi : le chemin vient de l'application.
        if let Some(d) = crate::db::repos::doc_get(c, doc_id).await?
            && let Some(folder) = d.folder.as_deref().filter(|f| !f.is_empty())
            && !path_in_scope(&self.agent.definition, &format!("{folder}/{}", d.name.as_deref().unwrap_or("")))
        {
            return Ok(false);
        }
        match access::require_document_read(c, self.user, vault_id, doc_id).await {
            Ok(()) => Ok(!is_end_to_end(c, vault_id).await?),
            Err(AppError::VaultNotFound(_) | AppError::DocumentNotInVault(_) | AppError::AccessDenied(_) | AppError::DocumentNotFound(_)) => Ok(false),
            Err(e) => Err(e),
        }
    }
}

pub struct ToolReply {
    pub text: String,
    pub is_error: bool,
    /// Les memes donnees, pour une IA qui lit le resultat structure.
    pub data: Option<Value>,
}

fn quoted(s: &str) -> String {
    format!("« {} »", s.replace('\n', " ⏎ "))
}

fn mark_json(m: &AiMarkRow, vault_name: &str) -> Value {
    json!({
        "id": m.id, "vault": vault_name, "vaultId": m.vault_id, "noteId": m.doc_id, "path": m.path, "label": m.label,
        "text": m.anchor.get("quote").and_then(Value::as_str).unwrap_or(""), "anchor": m.anchor, "createdAt": m.created_at,
    })
}

/// Les marques de ce genre que l'agent peut voir.
async fn visible_marks(c: &mut PgConnection, sight: &Sight<'_>, kind: &str, vault_id: Option<&str>, limit: usize) -> AppResult<Vec<(AiMarkRow, String)>> {
    let mut out = vec![];
    for m in db::list(c, sight.user, vault_id, None, Some(kind), MAX_MARKS_PER_USER).await? {
        if out.len() >= limit {
            break;
        }
        if sight.sees(c, &m.vault_id, &m.doc_id, &m.path).await? {
            let name = sight.vault_name(&m.vault_id).unwrap_or("").to_string();
            out.push((m, name));
        }
    }
    Ok(out)
}

/// Un outil du contexte de l'editeur, pour l'agent du jeton.
pub async fn tool(st: &AppState, user: &str, agent: &AgentRow, vaults: &[(String, String)], name: &str, args: &Map<String, Value>) -> AppResult<ToolReply> {
    let sight = Sight { user, agent, vaults };
    if agents::mode_for(&agent.definition, "read") == "deny" {
        return Ok(ToolReply { text: format!("Droit refusé à « {} » : il ne lit pas les notes.", agent.name), is_error: true, data: None });
    }
    let mut c = st.db.acquire().await?;
    match name {
        LIST_PINS => {
            let wanted = args.get("vault").and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty());
            let vault_id = match wanted {
                None => None,
                Some(w) => match vaults.iter().find(|(id, n)| id == w || n.to_lowercase() == w.to_lowercase()) {
                    Some((id, _)) => Some(id.as_str()),
                    None => return Ok(ToolReply { text: format!("Vault introuvable : {w}."), is_error: true, data: None }),
                },
            };
            let pins = visible_marks(&mut c, &sight, "pin", vault_id, 100).await?;
            if pins.is_empty() {
                return Ok(ToolReply { text: "Aucune épingle pour l'IA.".into(), is_error: false, data: Some(json!({ "pins": [] })) });
            }
            let mut text = format!("{} épingle(s) pour l'IA :\n", pins.len());
            for (m, vault) in &pins {
                let quote = m.anchor.get("quote").and_then(Value::as_str).unwrap_or("");
                let what = if quote.is_empty() { "un endroit (curseur)".to_string() } else { quoted(quote) };
                text.push_str(&format!("- {} : {} (vault : {vault}, id de la note : {})\n  {what}\n  ancre : {}\n", m.label, m.path, m.doc_id, m.anchor));
            }
            let data: Vec<Value> = pins.iter().map(|(m, v)| mark_json(m, v)).collect();
            Ok(ToolReply { text, is_error: false, data: Some(json!({ "pins": data })) })
        }
        _ => {
            let seconds_ago = args.get("seconds_ago").and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64))).unwrap_or(0).clamp(0, MAX_SECONDS_AGO) as u64;
            let highlights = visible_marks(&mut c, &sight, "highlight", None, 50).await?;
            let found = match st.editor_contexts.at(user, seconds_ago, Instant::now()) {
                Some((e, age)) => {
                    let seen = sight.sees(&mut c, &e.vault_id, &e.doc_id, &e.path).await?;
                    Some((e, age, seen))
                }
                None => None,
            };
            let mut text = String::new();
            let mut data = json!({});
            match found {
                None => text.push_str("Aucun contexte : la personne n'a pas de note ouverte dans Savoire (ou pas depuis le dernier démarrage du serveur). Demandez-lui de quelle note elle parle.\n"),
                Some((_, _, false)) => {
                    text.push_str("Aucun contexte accessible : la personne travaille dans une note hors de la portée de cet agent. Demandez-lui de quelle note elle parle.\n");
                }
                Some((e, age, true)) => {
                    let vault = sight.vault_name(&e.vault_id).unwrap_or("");
                    let stale = age > STALE_SECONDS;
                    let hint = if stale {
                        "Ce contexte date de plus de 2 minutes : demandez à la personne de confirmer que c'est bien ce passage avant d'agir."
                    } else {
                        "Contexte récent. La sélection éclaire la demande, sans être une vérité absolue : en cas de doute, demandez."
                    };
                    text.push_str(&format!("Contexte de l'éditeur de Savoire, il y a {age} s.\n"));
                    text.push_str(&format!("Note : {} (vault : {vault}, id du vault : {}, id de la note : {})\n", e.path, e.vault_id, e.doc_id));
                    if !e.heading_path.is_empty() {
                        text.push_str(&format!("Section : {}\n", e.heading_path.join(" > ")));
                    }
                    if e.selection.is_empty() {
                        text.push_str(&format!("Pas de sélection : le curseur est entre {} et {}.\n", quoted(&e.before), quoted(&e.after)));
                    } else {
                        text.push_str(&format!(
                            "Sélection ({} caractères{}) :\n{}\n",
                            e.selection.chars().count(),
                            if e.selection_truncated { ", tronquée" } else { "" },
                            e.selection
                        ));
                        text.push_str(&format!("Juste avant : {}\nJuste après : {}\n", quoted(&e.before), quoted(&e.after)));
                    }
                    text.push_str(&format!("Ancre : {}\n", e.anchor));
                    text.push_str(&format!("{hint}\n"));
                    // Elle tape dans cette note : l'IA le sait avant d'ecrire.
                    let typing = st.editor_contexts.typing(user, &e.vault_id, Instant::now()).is_some_and(|(t, _)| t.doc_id == e.doc_id);
                    if typing {
                        text.push_str("La personne écrit dans cette note en ce moment : n'écrivez pas dans son paragraphe. Attendez, ou proposez (propose: true).\n");
                    }
                    data = json!({
                        "ageSeconds": age, "stale": stale, "hint": hint,
                        "vault": vault, "vaultId": e.vault_id, "noteId": e.doc_id, "path": e.path,
                        "selection": e.selection, "selectionTruncated": e.selection_truncated, "isCursor": e.selection.is_empty(),
                        "before": e.before, "after": e.after, "headingPath": e.heading_path, "blockHash": e.block_hash,
                        "anchor": e.anchor, "at": e.received_at, "tabId": e.tab_id,
                    });
                    if typing {
                        data["typing"] = json!(true);
                    }
                }
            }
            if !highlights.is_empty() {
                text.push_str(&format!("\nPassages surlignés pour l'IA ({}) :\n", highlights.len()));
                for (m, vault) in &highlights {
                    let quote = m.anchor.get("quote").and_then(Value::as_str).unwrap_or("");
                    text.push_str(&format!("- {} (vault : {vault}, id de la note : {}) : {}\n  ancre : {}\n", m.path, m.doc_id, quoted(quote), m.anchor));
                }
            }
            data["highlights"] = json!(highlights.iter().map(|(m, v)| mark_json(m, v)).collect::<Vec<Value>>());
            Ok(ToolReply { text, is_error: false, data: Some(data) })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(doc: &str, received: Instant) -> ContextEntry {
        ContextEntry {
            vault_id: "v".into(),
            doc_id: doc.into(),
            path: format!("{doc}.md"),
            selection: String::new(),
            selection_truncated: false,
            anchor: json!({}),
            before: String::new(),
            after: String::new(),
            heading_path: vec![],
            block_hash: String::new(),
            tab_id: "t".into(),
            client_at: None,
            received,
            received_at: now(),
        }
    }

    #[test]
    fn ring_keeps_a_minute_and_always_the_last_entry() {
        let store = ContextStore::new();
        let t0 = Instant::now();
        let s = Duration::from_secs;
        store.push("u", entry("a", t0));
        store.push("u", entry("b", t0 + s(30)));
        store.push("u", entry("c", t0 + s(50)));
        assert_eq!(store.users.get("u").unwrap().len(), 3);
        // Une minute plus tard : « a » sort (plus de 60 s avant la derniere), pas les autres.
        store.push("u", entry("d", t0 + s(80)));
        let docs: Vec<String> = store.users.get("u").unwrap().iter().map(|e| e.doc_id.clone()).collect();
        assert_eq!(docs, vec!["b", "c", "d"]);
        // Longtemps apres, sans rien de neuf : la derniere entree est toujours la.
        let (last, age) = store.at("u", 0, t0 + s(4000)).unwrap();
        assert_eq!((last.doc_id.as_str(), age), ("d", 3920));
        // Une seule entree neuve chasse tout le reste.
        store.push("u", entry("e", t0 + s(5000)));
        assert_eq!(store.users.get("u").unwrap().len(), 1);
        assert!(store.at("autre", 0, t0).is_none());
        store.forget("u");
        assert!(store.at("u", 0, t0).is_none());
    }

    #[test]
    fn at_reads_where_the_person_was_when_she_spoke() {
        let store = ContextStore::new();
        let t0 = Instant::now();
        let s = Duration::from_secs;
        store.push("u", entry("selection", t0));
        store.push("u", entry("ailleurs", t0 + s(8)));
        let now = t0 + s(10);
        // Maintenant : la derniere. Il y a 5 s : ce qui etait selectionne alors (pas l'entree la plus proche).
        assert_eq!(store.at("u", 0, now).unwrap().0.doc_id, "ailleurs");
        let (then, age) = store.at("u", 5, now).unwrap();
        assert_eq!((then.doc_id.as_str(), age), ("selection", 10));
        // Avant tout ce qui est garde : la plus ancienne.
        assert_eq!(store.at("u", 3000, now).unwrap().0.doc_id, "selection");
    }

    #[test]
    fn typing_is_known_for_a_few_seconds_in_its_vault_only() {
        let store = ContextStore::new();
        let t0 = Instant::now();
        let ms = Duration::from_millis;
        let typed = |doc: &str, at: Instant| TypingEntry { vault_id: "v".into(), doc_id: doc.into(), block_hash: "h".into(), anchor: json!({}), typed: at };
        assert!(store.typing("u", "v", t0).is_none());
        store.typed("u", typed("a", t0));
        let (e, age) = store.typing("u", "v", t0 + ms(3000)).unwrap();
        assert_eq!((e.doc_id.as_str(), age), ("a", 3000));
        // Un autre vault, une autre personne : rien.
        assert!(store.typing("u", "autre", t0 + ms(3000)).is_none());
        assert!(store.typing("bob", "v", t0 + ms(3000)).is_none());
        // Apres 8 s sans frappe : elle ne tape plus.
        assert!(store.typing("u", "v", t0 + ms(TYPING_GUARD_MS)).is_none());
        // La derniere frappe l'emporte.
        store.typed("u", typed("b", t0 + ms(9000)));
        assert_eq!(store.typing("u", "v", t0 + ms(9500)).unwrap().0.doc_id, "b");
        store.forget("u");
        assert!(store.typing("u", "v", t0 + ms(9500)).is_none());
    }

    #[test]
    fn ring_is_bounded() {
        let store = ContextStore::new();
        let t0 = Instant::now();
        for i in 0..(RING_MAX as u64 * 3) {
            store.push("u", entry("x", t0 + Duration::from_millis(i * 10)));
        }
        assert_eq!(store.users.get("u").unwrap().len(), RING_MAX);
    }

    #[test]
    fn anchors_are_bounded_and_keep_the_request_document() {
        let long = "é".repeat(5000);
        let a = clean_anchor(Some(&json!({ "docId": "autre", "start": "AAEB", "end": "AAEC", "quote": long, "prefix": "x".repeat(40) + "fin", "suffix": "debut".to_string() + &"y".repeat(40), "extra": 1 })), "doc").unwrap();
        assert_eq!(a["docId"], "doc");
        assert_eq!(a["quote"].as_str().unwrap().chars().count(), MAX_SELECTION_CHARS);
        // Le prefixe garde sa fin (ce qui touche le passage), le suffixe son debut.
        assert!(a["prefix"].as_str().unwrap().ends_with("fin") && a["prefix"].as_str().unwrap().chars().count() == 32);
        assert!(a["suffix"].as_str().unwrap().starts_with("debut") && a["suffix"].as_str().unwrap().chars().count() == 32);
        assert!(a.get("extra").is_none());
        assert!(clean_anchor(Some(&json!({ "start": "", "end": "AAEC" })), "doc").is_err());
        assert!(clean_anchor(Some(&json!({ "start": "pas du base64 !", "end": "AAEC" })), "doc").is_err());
        assert!(clean_anchor(None, "doc").is_err());
    }

    #[test]
    fn folders_of_the_agent_scope() {
        let def = json!({ "scope": { "folders": ["/Projets/", "Journal"] } });
        assert!(path_in_scope(&def, "Projets/Plan.md"));
        assert!(path_in_scope(&def, "Journal/2026/a.md"));
        assert!(!path_in_scope(&def, "Prive/a.md"));
        assert!(!path_in_scope(&def, "Projets2/a.md"));
        assert!(path_in_scope(&json!({}), "Prive/a.md"));
        assert!(path_in_scope(&json!({ "scope": { "folders": [] } }), "Prive/a.md"));
    }
}
