// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Publier une note sur le web : une adresse publique en lecture seule,
// /p/{slug}, mise a jour a chaque modification de la note. Le serveur ne lit
// pas les notes (CRDT) : l'application rend la page en HTML et l'envoie. La
// page est servie telle quelle, sous une politique qui interdit tout script.
//   GET    /api/v1/vaults/{vaultId}/documents/{docId}/publication
//   PUT    /api/v1/vaults/{vaultId}/documents/{docId}/publication            (administrateurs)
//   PUT    /api/v1/vaults/{vaultId}/documents/{docId}/publication/content    (redacteurs, page deja publiee)
//   DELETE /api/v1/vaults/{vaultId}/documents/{docId}/publication            (administrateurs)
//   GET    /p/{slug}[?embed=1]

use std::sync::LazyLock;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use rand::Rng;
use regex::Regex;
use serde::Deserialize;
use serde_json::json;
use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::is_combining_mark;

use super::{Body, Policy, ReqParts, client_ip, no_content, ok, public_base, rate};
use crate::access::{self, Level};
use crate::auth::Auth;
use crate::db::repos;
use crate::domain::{Publication, now};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub const MAX_HTML_CHARS: usize = 15 * 1024 * 1024;
const MAX_TITLE_CHARS: usize = 300;
const MAX_DESCRIPTION_CHARS: usize = 500;
pub const MAX_REQUEST_BYTES: usize = 32 * 1024 * 1024;

fn dto(p: &Publication) -> serde_json::Value {
    json!({ "slug": p.slug, "path": format!("/p/{}", p.slug), "indexable": p.indexable, "createdAt": p.created_at, "updatedAt": p.updated_at })
}

/// Tronque a `max` unites UTF-16, comme le faisait le serveur .NET.
fn clip(s: &str, max: usize) -> String {
    let mut n = 0;
    let mut out = String::new();
    for ch in s.chars() {
        n += ch.len_utf16();
        if n > max {
            break;
        }
        out.push(ch);
    }
    out
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// « Mon rapport 2026 » -> « mon-rapport-2026-k3x9p2 ».
pub fn slugify(title: &str) -> String {
    let mut sb = String::new();
    for c in title.nfd() {
        if is_combining_mark(c) {
            continue;
        }
        sb.push(if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' });
    }
    static DASHES: LazyLock<Regex> = LazyLock::new(|| Regex::new("-+").unwrap());
    let mut slug = DASHES.replace_all(&sb, "-").trim_matches('-').to_string();
    if slug.len() > 60 {
        slug = slug[..60].trim_end_matches('-').to_string();
    }
    const ALPHABET: &[u8] = b"abcdefghijkmnpqrstuvwxyz23456789";
    let mut rng = rand::rng();
    let suffix: String = (0..6).map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())] as char).collect();
    if slug.is_empty() { suffix } else { format!("{slug}-{suffix}") }
}

async fn ensure_in_vault(c: &mut sqlx::PgConnection, vault_id: &str, doc_id: &str) -> AppResult<()> {
    if repos::doc_vault_id(c, doc_id).await?.as_deref() != Some(vault_id) {
        return Err(AppError::DocumentNotFound(doc_id.into()));
    }
    Ok(())
}

pub async fn get(State(st): State<AppState>, Auth(p): Auth, Path((vault_id, doc_id)): Path<(String, String)>) -> AppResult<Response> {
    let mut c = st.db.acquire().await?;
    access::check_vault(&mut c, &p.sub, &vault_id, Level::Read).await?;
    ensure_in_vault(&mut c, &vault_id, &doc_id).await?;
    Ok(match repos::publication_by_document(&mut c, &doc_id).await? {
        Some(pb) => ok(&dto(&pb)),
        None => no_content(),
    })
}

#[derive(Deserialize)]
pub struct PublishRequest {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    html: Option<String>,
    #[serde(default)]
    indexable: bool,
}

/// Publie la note, ou met a jour sa page. Reserve aux administrateurs du vault.
pub async fn publish(
    State(st): State<AppState>,
    Auth(p): Auth,
    ReqParts(parts): ReqParts,
    Path((vault_id, doc_id)): Path<(String, String)>,
    Body(req): Body<PublishRequest>,
) -> AppResult<Response> {
    if let Err(r) = rate(&st, Policy::Publish, Some(&p.sub), &client_ip(&st, &parts)) {
        return Ok(r);
    }
    let html = req.html.unwrap_or_default();
    let mut c = st.db.acquire().await?;
    access::check_vault(&mut c, &p.sub, &vault_id, Level::Admin).await?;
    st.quota.ensure_room(&st.limits(), &vault_id, html.len() as i64).await?;
    if utf16_len(&html) > MAX_HTML_CHARS {
        return Err(AppError::validation("Page trop lourde pour être publiée."));
    }
    ensure_in_vault(&mut c, &vault_id, &doc_id).await?;
    let title = clip(req.title.unwrap_or_default().trim(), MAX_TITLE_CHARS);
    let description = clip(req.description.unwrap_or_default().trim(), MAX_DESCRIPTION_CHARS);
    let at = now();
    if let Some(mut existing) = repos::publication_by_document(&mut c, &doc_id).await? {
        repos::publication_update(&mut c, &doc_id, &title, &description, &html, req.indexable, at).await?;
        existing.indexable = req.indexable;
        existing.updated_at = at;
        return Ok(ok(&dto(&existing)));
    }
    let slug = loop {
        let s = slugify(&title);
        if !repos::publication_slug_exists(&mut c, &s).await? {
            break s;
        }
    };
    let created = Publication {
        slug,
        vault_id: vault_id.clone(),
        document_id: doc_id,
        title,
        description,
        html,
        indexable: req.indexable,
        created_by: p.sub,
        created_at: at,
        updated_at: at,
    };
    repos::publication_add(&mut c, &created).await?;
    Ok(ok(&dto(&created)))
}

/// Met a jour le contenu d'une page DEJA publiee. Un redacteur le peut. Sans page : 404.
pub async fn refresh(
    State(st): State<AppState>,
    Auth(p): Auth,
    ReqParts(parts): ReqParts,
    Path((vault_id, doc_id)): Path<(String, String)>,
    Body(req): Body<PublishRequest>,
) -> AppResult<Response> {
    if let Err(r) = rate(&st, Policy::Publish, Some(&p.sub), &client_ip(&st, &parts)) {
        return Ok(r);
    }
    let html = req.html.unwrap_or_default();
    let mut c = st.db.acquire().await?;
    access::check_vault(&mut c, &p.sub, &vault_id, Level::Write).await?;
    st.quota.ensure_room(&st.limits(), &vault_id, html.len() as i64).await?;
    if utf16_len(&html) > MAX_HTML_CHARS {
        return Err(AppError::validation("Page trop lourde pour être publiée."));
    }
    ensure_in_vault(&mut c, &vault_id, &doc_id).await?;
    let mut existing = repos::publication_by_document(&mut c, &doc_id).await?.ok_or_else(|| AppError::DocumentNotFound(doc_id.clone()))?;
    let title = clip(req.title.unwrap_or_default().trim(), MAX_TITLE_CHARS);
    let description = clip(req.description.unwrap_or_default().trim(), MAX_DESCRIPTION_CHARS);
    let at = now();
    repos::publication_update(&mut c, &doc_id, &title, &description, &html, existing.indexable, at).await?;
    existing.updated_at = at;
    Ok(ok(&dto(&existing)))
}

pub async fn unpublish(State(st): State<AppState>, Auth(p): Auth, Path((vault_id, doc_id)): Path<(String, String)>) -> AppResult<Response> {
    let mut c = st.db.acquire().await?;
    access::check_vault(&mut c, &p.sub, &vault_id, Level::Admin).await?;
    ensure_in_vault(&mut c, &vault_id, &doc_id).await?;
    repos::publication_delete(&mut c, &doc_id).await?;
    st.quota.invalidate(&vault_id);
    Ok(no_content())
}

#[derive(Deserialize)]
pub struct PageQuery {
    embed: Option<String>,
}

/// Page publique, sans compte.
pub async fn page(State(st): State<AppState>, ReqParts(parts): ReqParts, Path(slug): Path<String>, Query(q): Query<PageQuery>) -> AppResult<Response> {
    static SLUG: LazyLock<Regex> = LazyLock::new(|| Regex::new("^[a-z0-9-]{1,120}$").unwrap());
    let embedded = q.embed.as_deref() == Some("1");
    let mut found = None;
    if SLUG.is_match(&slug) {
        let mut c = st.db.acquire().await?;
        if let Some(pb) = repos::publication_by_slug(&mut c, &slug).await? {
            // Note ou vault supprime : la page ne repond plus.
            if repos::doc_vault_id(&mut c, &pb.document_id).await?.as_deref() == Some(pb.vault_id.as_str()) {
                found = Some(pb);
            }
        }
    }
    let csp = format!(
        "default-src 'none'; img-src data: https:; style-src 'unsafe-inline'; font-src data:; {}base-uri 'none'; form-action 'none'; sandbox allow-popups allow-popups-to-escape-sandbox",
        if embedded { "frame-ancestors *; " } else { "frame-ancestors 'self'; " }
    );
    let (code, html, pb) = match found {
        None => (StatusCode::NOT_FOUND, not_found_page(), None),
        Some(pb) => {
            let url = format!("{}/p/{}", public_base(&st, &parts), pb.slug);
            (StatusCode::OK, render(&pb, &url, embedded), Some(pb))
        }
    };
    let mut res = (code, html).into_response();
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
    h.insert("content-security-policy", HeaderValue::from_str(&csp).unwrap());
    h.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    h.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    match pb {
        None => {
            h.insert("x-robots-tag", HeaderValue::from_static("noindex"));
        }
        Some(pb) => {
            if !pb.indexable {
                h.insert("x-robots-tag", HeaderValue::from_static("noindex, nofollow"));
            }
            h.insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=30"));
            if let Ok(v) = HeaderValue::from_str(&pb.updated_at.format("%a, %d %b %Y %H:%M:%S GMT").to_string()) {
                h.insert(header::LAST_MODIFIED, v);
            }
        }
    }
    Ok(res)
}

fn e(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

const STYLE: &str = r#":root { color-scheme: light dark; --text:#1e293b; --muted:#64748b; --border:#e2e8f0; --bg:#fff; --accent:#7f6df2; --code:#f1f5f9; }
@media (prefers-color-scheme: dark) { :root { --text:#dadada; --muted:#9aa3ae; --border:#333; --bg:#1e1e1e; --accent:#8a7cf7; --code:#2a2a2a; } }
body { margin:0; background:var(--bg); color:var(--text); font:17px/1.65 'Source Serif 4', Georgia, serif; }
main { max-width:760px; margin:0 auto; padding:48px 24px 80px; }
h1,h2,h3,h4 { font-family: Inter, system-ui, sans-serif; line-height:1.3; }
a { color:var(--accent); }
img { max-width:100%; height:auto; border-radius:6px; }
pre, code { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size:.88em; background:var(--code); border-radius:4px; }
pre { padding:12px 14px; overflow-x:auto; } code { padding:1px 4px; } pre code { padding:0; background:none; }
table { border-collapse:collapse; width:100%; margin:1em 0; font-size:.92em; } td, th { border:1px solid var(--border); padding:6px 10px; text-align:left; }
blockquote { margin:1em 0; padding:.2em 1em; border-left:3px solid var(--border); color:var(--muted); }
hr { border:none; border-top:1px solid var(--border); }
footer { max-width:760px; margin:0 auto; padding:0 24px 40px; font:13px Inter, system-ui, sans-serif; color:var(--muted); }
footer a { color:inherit; }"#;

const EMBED_STYLE: &str = "body { background: transparent; } main { max-width: none; padding: 8px 12px; }";

pub fn render(p: &Publication, url: &str, embedded: bool) -> String {
    let robots = if p.indexable && !embedded { "" } else { "<meta name=\"robots\" content=\"noindex, nofollow\">" };
    let refresh = if embedded { "<meta http-equiv=\"refresh\" content=\"60\">" } else { "" };
    let footer = if embedded {
        String::new()
    } else {
        format!("<footer>Mis à jour le {} UTC · Publié avec Savoire</footer>", p.updated_at.format("%d/%m/%Y à %H:%M"))
    };
    format!(
        "<!doctype html>\n<html lang=\"fr\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
<title>{t}</title>\n<meta name=\"description\" content=\"{d}\">\n<link rel=\"canonical\" href=\"{u}\">\n<meta property=\"og:type\" content=\"article\">\n\
<meta property=\"og:title\" content=\"{t}\">\n<meta property=\"og:description\" content=\"{d}\">\n<meta property=\"og:url\" content=\"{u}\">\n\
<meta name=\"twitter:card\" content=\"summary\">\n<meta name=\"generator\" content=\"Savoire\">\n{robots}\n{refresh}\n<style>{STYLE}{es}</style>\n</head>\n<body>\n<main>\n{html}\n</main>\n{footer}\n</body>\n</html>",
        t = e(&p.title),
        d = e(&p.description),
        u = e(url),
        es = if embedded { EMBED_STYLE } else { "" },
        html = p.html,
    )
}

pub fn not_found_page() -> String {
    format!(
        "<!doctype html><html lang=\"fr\"><head><meta charset=\"utf-8\"><title>Page introuvable</title><style>{STYLE}</style></head>\n\
<body><main><h1>Page introuvable</h1><p>Cette page n’est pas (ou plus) publiée.</p></main></body></html>"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_from_title() {
        let s = slugify("Mon rapport 2026 : été");
        assert!(s.starts_with("mon-rapport-2026-ete-"), "{s}");
        assert_eq!(s.len(), "mon-rapport-2026-ete-".len() + 6);
        assert_eq!(slugify("!!!").len(), 6);
        assert!(slugify(&"a".repeat(100)).len() <= 67);
    }

    #[test]
    fn escapes_and_clips() {
        assert_eq!(e("<a href=\"x\">&'"), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
        assert_eq!(clip("abcdef", 3), "abc");
        assert_eq!(clip("ab😀", 3), "ab");
    }

    #[test]
    fn page_rendering() {
        let p = Publication {
            slug: "s".into(),
            vault_id: "v".into(),
            document_id: "d".into(),
            title: "T<1>".into(),
            description: "D".into(),
            html: "<p>x</p>".into(),
            indexable: false,
            created_by: "u".into(),
            created_at: now(),
            updated_at: now(),
        };
        let h = render(&p, "https://h/p/s", false);
        assert!(h.contains("<title>T&lt;1&gt;</title>"));
        assert!(h.contains("noindex, nofollow"));
        assert!(h.contains("<p>x</p>"));
        assert!(h.contains("<footer>"));
        assert!(!render(&p, "u", true).contains("<footer>"));
    }
}
