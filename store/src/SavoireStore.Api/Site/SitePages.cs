// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le petit site du store : rendu cote serveur, sans script, referencable.
//   /                 le catalogue (recherche, sorte, tri)
//   /items/{id}       un element : description, droits demandes, versions, avis
// Laisser un avis ou installer se fait depuis l'application Savoire (compte
// connecte) ; le site renvoie vers elle.
using System.Net;
using System.Text;
using SavoireStore.Api;
using SavoireStore.Data;

namespace SavoireStore.Site;

public static class SitePages
{
    public const string Csp = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https: data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

    private static string E(string? s) => WebUtility.HtmlEncode(s ?? "");

    /// <summary>
    /// Prefixe des adresses du site : vide a la racine d'un domaine, « /store »
    /// sous l'adresse de Savoire (Store:PathBase). Pose par requete.
    /// </summary>
    private static readonly AsyncLocal<string?> basePath = new();
    public static string Base { get => basePath.Value ?? ""; set => basePath.Value = value; }

    private static readonly Dictionary<string, string> KindNames = new()
    {
        [ItemKinds.Plugin] = "Plugin", [ItemKinds.Template] = "Modèle de note", [ItemKinds.Module] = "Module", [ItemKinds.Notes] = "Notes", [ItemKinds.Agent] = "Agent IA",
    };

    private static readonly Dictionary<string, string> PermissionNames = new()
    {
        ["vault:read"] = "Lire les notes du vault",
        ["vault:write"] = "Modifier les notes du vault",
        ["network:*"] = "Accéder à Internet (tous les sites)",
        ["ui:editor"] = "Ajouter un éditeur",
        ["ui:settings"] = "Ajouter des réglages",
        ["agents"] = "Proposer des agents",
        ["ai"] = "Utiliser votre IA",
    };

    private const string Style = """
        :root { color-scheme: light dark; --accent: #0d9488; --muted: #64748b; --border: #e2e8f0; --bg: #ffffff; --card: #f8fafc; --text: #0f172a; }
        @media (prefers-color-scheme: dark) { :root { --border: #334155; --bg: #0f172a; --card: #1e293b; --text: #e2e8f0; --muted: #94a3b8; } }
        * { box-sizing: border-box; }
        body { margin: 0; font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
        header { border-bottom: 1px solid var(--border); padding: 14px 16px; }
        header a { color: inherit; text-decoration: none; font-weight: 700; }
        main { max-width: 920px; margin: 0 auto; padding: 20px 16px 60px; }
        form.search { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 18px; }
        input, select, button { font: inherit; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--card); color: var(--text); }
        input[type=search] { flex: 1 1 240px; }
        button { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; cursor: pointer; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
        .card { display: block; border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; background: var(--card); color: inherit; text-decoration: none; }
        .card:hover { border-color: var(--accent); }
        .card h3 { margin: 0 0 4px; font-size: 16px; }
        .meta { color: var(--muted); font-size: 13px; }
        .tag { display: inline-block; font-size: 12px; padding: 1px 8px; border-radius: 99px; border: 1px solid var(--border); margin-right: 4px; }
        .stars { color: #f59e0b; }
        ul.perms li { margin: 2px 0; }
        .review { border-top: 1px solid var(--border); padding: 10px 0; }
        .reply { margin: 6px 0 0 16px; padding-left: 10px; border-left: 3px solid var(--accent); }
        .pager { margin-top: 18px; display: flex; gap: 12px; }
        a { color: var(--accent); }
        pre.desc { white-space: pre-wrap; font: inherit; }
        """;

    private static string Layout(string title, string description, string body, string? canonical = null) => $"""
        <!doctype html>
        <html lang="fr">
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>{E(title)}</title>
        <meta name="description" content="{E(description)}">
        {(canonical is null ? "" : $"<link rel=\"canonical\" href=\"{E(canonical)}\">")}
        <meta property="og:title" content="{E(title)}">
        <meta property="og:description" content="{E(description)}">
        <style>{Style}</style>
        </head>
        <body>
        <header><a href="{E(Base)}/">Savoire Store</a></header>
        <main>
        {body}
        </main>
        </body>
        </html>
        """;

    private static string Stars(double? rating, int count) =>
        rating is double r ? $"<span class=\"stars\">{new string('★', (int)Math.Round(r))}{new string('☆', 5 - (int)Math.Round(r))}</span> {r:0.0} ({count})" : "Pas encore d'avis";

    private static string Price(PriceDto? p) => p is null ? "Gratuit" : $"{p.Cents / 100.0:0.00} {E(p.Currency)}";

    public static string Catalog(ItemPageDto page, string? q, string? kind, string? sort)
    {
        var sb = new StringBuilder();
        sb.Append("<h1>Plugins, modèles et modules pour Savoire</h1>");
        sb.Append($"<form class=\"search\" method=\"get\" action=\"{E(Base)}/\">");
        sb.Append($"<input type=\"search\" name=\"q\" value=\"{E(q)}\" placeholder=\"Chercher…\" aria-label=\"Chercher\">");
        sb.Append("<select name=\"kind\" aria-label=\"Sorte\"><option value=\"\">Tout</option>");
        foreach ((string k, string label) in KindNames) sb.Append($"<option value=\"{k}\"{(kind == k ? " selected" : "")}>{label}</option>");
        sb.Append("</select><select name=\"sort\" aria-label=\"Tri\">");
        foreach ((string s, string label) in new[] { ("popular", "Les plus installés"), ("recent", "Les plus récents"), ("rating", "Les mieux notés"), ("name", "Par nom") })
            sb.Append($"<option value=\"{s}\"{((sort ?? "popular") == s ? " selected" : "")}>{label}</option>");
        sb.Append("</select><button type=\"submit\">Chercher</button></form>");
        if (page.Items.Count == 0) sb.Append("<p class=\"meta\">Rien trouvé.</p>");
        sb.Append("<div class=\"grid\">");
        foreach (ItemSummaryDto i in page.Items)
        {
            sb.Append($"<a class=\"card\" href=\"{E(Base)}/items/{Uri.EscapeDataString(i.Id)}\"><h3>{E(i.Name)}</h3>");
            sb.Append($"<div class=\"meta\"><span class=\"tag\">{E(KindNames.GetValueOrDefault(i.Kind, i.Kind))}</span>{E(i.Author)} · v{E(i.LatestVersion)}</div>");
            sb.Append($"<p>{E(i.Summary)}</p><div class=\"meta\">{Stars(i.Rating, i.RatingCount)} · {i.Downloads} installation(s) · {Price(i.Price)}</div></a>");
        }
        sb.Append("</div>");
        int pages = (page.Total + page.PageSize - 1) / page.PageSize;
        if (pages > 1)
        {
            string Link(int p) => $"{Base}/?q={Uri.EscapeDataString(q ?? "")}&kind={Uri.EscapeDataString(kind ?? "")}&sort={Uri.EscapeDataString(sort ?? "")}&page={p}";
            sb.Append("<nav class=\"pager\">");
            if (page.Page > 1) sb.Append($"<a href=\"{E(Link(page.Page - 1))}\">← Précédents</a>");
            sb.Append($"<span class=\"meta\">Page {page.Page} / {pages}</span>");
            if (page.Page < pages) sb.Append($"<a href=\"{E(Link(page.Page + 1))}\">Suivants →</a>");
            sb.Append("</nav>");
        }
        return Layout("Savoire Store", "Plugins, modèles de notes et modules pour Savoire.", sb.ToString());
    }

    public static string Item(ItemDetailDto d, IReadOnlyList<ReviewDto> reviews, string canonical)
    {
        ItemSummaryDto i = d.Item;
        var sb = new StringBuilder();
        sb.Append($"<p class=\"meta\"><span class=\"tag\">{E(KindNames.GetValueOrDefault(i.Kind, i.Kind))}</span>par {E(i.Author)} · version {E(i.LatestVersion)} · {i.Downloads} installation(s) · {Price(i.Price)}</p>");
        sb.Append($"<h1>{E(i.Name)}</h1><p><strong>{E(i.Summary)}</strong></p>");
        sb.Append($"<p>{Stars(i.Rating, i.RatingCount)}</p>");
        sb.Append($"<p>Pour l'installer : dans Savoire, <em>Paramètres → Plugins</em>, cherchez « {E(i.Name)} » (bientôt).</p>");
        if (d.Description != i.Summary) sb.Append($"<h2>Description</h2><pre class=\"desc\">{E(d.Description)}</pre>");
        if (i.Kind != ItemKinds.Agent) sb.Append("<h2>Droits demandés</h2>");
        if (i.Kind == ItemKinds.Agent)
        {
            // Un modele d'agent n'a pas de droits de plugin : ses droits sont dans agent.json.
            if (d.Agent is not null) AgentSection(sb, d.Agent);
        }
        else if (d.Permissions.Count == 0) sb.Append("<p class=\"meta\">Aucun droit particulier.</p>");
        else
        {
            sb.Append("<ul class=\"perms\">");
            foreach (string p in d.Permissions) sb.Append($"<li>{E(PermissionNames.GetValueOrDefault(p, p))}</li>");
            sb.Append("</ul>");
        }
        if (i.Kind == ItemKinds.Plugin)
        {
            sb.Append("<h2>Fonctionne avec</h2>");
            IReadOnlyList<string> caps = d.Capabilities ?? [];
            if (caps.Count == 0) sb.Append("<p class=\"meta\">Le plugin n'annonce aucun système de Savoire.</p>");
            else
            {
                sb.Append("<ul class=\"perms\">");
                foreach (string c in caps) sb.Append($"<li>{E(Publishing.PackageChecks.Capabilities.GetValueOrDefault(c, c))}</li>");
                sb.Append("</ul>");
            }
            sb.Append(d.Runtime == "frame"
                ? "<p class=\"meta\">Tourne dans un cadre isolé, avec une API réduite.</p>"
                : "<p class=\"meta\">Tourne dans Savoire, avec toute l'API, sur votre appareil seulement (jamais sur le serveur).</p>");
        }
        sb.Append("<h2>Informations</h2><ul>");
        sb.Append($"<li>Code source : <a href=\"https://github.com/{E(d.Repo)}\" rel=\"nofollow noopener\">github.com/{E(d.Repo)}</a></li>");
        if (d.License is not null) sb.Append($"<li>Licence : {E(d.License)}</li>");
        if (d.Homepage is not null && d.Homepage.StartsWith("https://", StringComparison.Ordinal))
            sb.Append($"<li>Site : <a href=\"{E(d.Homepage)}\" rel=\"nofollow noopener\">{E(d.Homepage)}</a></li>");
        if (i.Categories.Count > 0) sb.Append($"<li>Catégories : {string.Join(", ", i.Categories.Select(E))}</li>");
        sb.Append("</ul><h2>Versions</h2><ul>");
        foreach (VersionDto v in d.Versions.Take(10))
            sb.Append($"<li>{E(v.Version)} · {v.PublishedAt:yyyy-MM-dd}{(v.MinAppVersion is null ? "" : $" · Savoire {E(v.MinAppVersion)} ou plus")}</li>");
        sb.Append("</ul>");
        sb.Append($"<h2>Avis ({i.RatingCount})</h2>");
        if (reviews.Count == 0) sb.Append("<p class=\"meta\">Pas encore d'avis. Donnez le vôtre depuis Savoire.</p>");
        foreach (ReviewDto r in reviews)
        {
            sb.Append($"<div class=\"review\"><div><span class=\"stars\">{new string('★', r.Rating)}{new string('☆', 5 - r.Rating)}</span> <strong>{E(r.UserName)}</strong> <span class=\"meta\">· v{r.MajorVersion} · {r.UpdatedAt:yyyy-MM-dd}</span></div>");
            if (r.Text.Length > 0) sb.Append($"<p>{E(r.Text)}</p>");
            if (r.Reply is not null) sb.Append($"<div class=\"reply\"><span class=\"meta\">Réponse de l'éditeur</span><p>{E(r.Reply)}</p></div>");
            sb.Append("</div>");
        }
        return Layout($"{i.Name} · Savoire Store", i.Summary, sb.ToString(), canonical);
    }

    private static readonly Dictionary<string, string> ActionNames = new()
    {
        ["read"] = "Lire les notes", ["comment"] = "Commenter", ["edit"] = "Modifier des notes", ["create"] = "Créer des notes",
        ["organize"] = "Ranger (déplacer, renommer)", ["delete"] = "Supprimer", ["plugin"] = "Utiliser les outils des plugins",
        ["delegate"] = "Confier des tâches à d'autres agents",
    };

    private static readonly Dictionary<string, string> ModeNames = new()
    {
        ["direct"] = "sans demander", ["ask"] = "avec votre accord", ["propose"] = "en proposition (à relire)", ["deny"] = "interdit",
    };

    /// <summary>Droits d'un modele d'agent, en clair : une ligne par action.</summary>
    private static void AgentSection(StringBuilder sb, Publishing.AgentPreset.Summary a)
    {
        sb.Append("<h2>Droits demandés</h2>");
        if (a.Rights.Count == 0) sb.Append("<p class=\"meta\">Aucun droit : l'agent ne peut rien faire.</p>");
        else
        {
            sb.Append("<ul class=\"perms\">");
            foreach ((string action, string mode) in a.Rights)
                sb.Append($"<li>{E(ActionNames.GetValueOrDefault(action, action))} : {E(ModeNames.GetValueOrDefault(mode, mode))}</li>");
            sb.Append("</ul>");
        }
        sb.Append("<p class=\"meta\">Savoire borne toujours l'agent par vos propres droits. ");
        sb.Append(a.VaultScoped ? "Agent conseillé pour un vault (partagé par ses membres)." : "Agent personnel.");
        if (a.Budget.Count > 0)
            sb.Append(" Budget : " + string.Join(", ", a.Budget.Select(b => $"{E(b.Key)} {b.Value}")) + ".");
        sb.Append("</p>");
        if (a.Instructions.Length > 0) sb.Append($"<h2>Consignes de l'agent</h2><pre class=\"desc\">{E(a.Instructions)}</pre>");
    }

    public static string NotFound() =>
        Layout("Introuvable · Savoire Store", "", $"<h1>Introuvable</h1><p><a href=\"{E(Base)}/\">Retour au catalogue</a></p>");
}
