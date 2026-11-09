// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using System.Net;
using Savoire.Domain.ReadModels;

namespace Savoire.Server.Publications;

/// <summary>Le cadre HTML d'une page publiee : titre, description, partage, styles.</summary>
public static class PublicPage
{
    private static string E(string s) => WebUtility.HtmlEncode(s);

    private const string Style = """
        :root { color-scheme: light dark; --text:#1e293b; --muted:#64748b; --border:#e2e8f0; --bg:#fff; --accent:#7f6df2; --code:#f1f5f9; }
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
        footer a { color:inherit; }
        """;

    public static string Render(Publication p, string url, bool embedded = false) => $"""
        <!doctype html>
        <html lang="fr">
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>{E(p.Title)}</title>
        <meta name="description" content="{E(p.Description)}">
        <link rel="canonical" href="{E(url)}">
        <meta property="og:type" content="article">
        <meta property="og:title" content="{E(p.Title)}">
        <meta property="og:description" content="{E(p.Description)}">
        <meta property="og:url" content="{E(url)}">
        <meta name="twitter:card" content="summary">
        <meta name="generator" content="Savoire">
        {(p.Indexable && !embedded ? "" : "<meta name=\"robots\" content=\"noindex, nofollow\">")}
        {(embedded ? "<meta http-equiv=\"refresh\" content=\"60\">" : "")}
        <style>{Style}{(embedded ? EmbedStyle : "")}</style>
        </head>
        <body>
        <main>
        {p.Html}
        </main>
        {(embedded ? "" : $"<footer>Mis à jour le {p.UpdatedAt:dd/MM/yyyy à HH:mm} UTC · Publié avec Savoire</footer>")}
        </body>
        </html>
        """;

    /// <summary>Integree ailleurs : sans marges ni pied, fond transparent. Rechargee chaque minute (en direct, sans script).</summary>
    private const string EmbedStyle = "body { background: transparent; } main { max-width: none; padding: 8px 12px; }";

    public static string NotFound() => $"""
        <!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Page introuvable</title><style>{Style}</style></head>
        <body><main><h1>Page introuvable</h1><p>Cette page n’est pas (ou plus) publiée.</p></main></body></html>
        """;
}
