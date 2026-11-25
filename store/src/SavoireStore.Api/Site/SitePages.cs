// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le site du store : rendu cote serveur, sans script, referencable.
//   /                     accueil : recherche, sortes, categories, selections
//   /catalogue            recherche et filtres (sorte, categorie, prix, note, tri)
//   /categories           toutes les categories ; /categories/{slug} : l'une d'elles
//   /items/{id}           la fiche : captures, description, droits, versions, avis
//   /publier              comment publier (docs/publier.md)
// Donner un avis demande un compte Savoire (connexion par Zitadel, SiteAuth).
// Installer se fait depuis l'application Savoire ; la fiche y renvoie.
using System.Net;
using System.Text;
using SavoireStore.Api;
using SavoireStore.Data;

namespace SavoireStore.Site;

/// <summary>Ce que chaque page sait de la visite : la personne connectee, le jeton anti-CSRF, un message.</summary>
public sealed record SiteContext(string Path, string? UserId, string? UserName, bool IsAdmin, string? Csrf, bool LoginEnabled, string? Notice, string? AppUrl)
{
    public bool SignedIn => UserId is not null;
}

public sealed record HomeModel(
    IReadOnlyList<ItemSummaryDto> Popular, IReadOnlyList<ItemSummaryDto> TopRated, IReadOnlyList<ItemSummaryDto> Recent,
    IReadOnlyList<CategoryCountDto> Categories, IReadOnlyDictionary<string, int> Kinds);

public sealed record CatalogModel(ItemPageDto Page, FacetsDto Facets, CatalogQuery Query, Category? FixedCategory);

public sealed record ItemModel(
    ItemDetailDto Detail, IReadOnlyList<ReviewDto> Reviews, int ReviewPage, int[] Distribution, ReviewDto? Mine,
    bool IsPublisher, IReadOnlyList<ItemSummaryDto> Related, string Canonical);

public static class SitePages
{
    public const string Csp = "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

    private static string E(string? s) => WebUtility.HtmlEncode(s ?? "");

    /// <summary>
    /// Prefixe des adresses du site : vide a la racine d'un domaine, « /store »
    /// sous l'adresse de Savoire (Store:PathBase). Pose par requete.
    /// </summary>
    private static readonly AsyncLocal<string?> basePath = new();
    public static string Base { get => basePath.Value ?? ""; set => basePath.Value = value; }

    private static string U(string path) => E(Base + path);

    public static readonly Dictionary<string, string> KindNames = new()
    {
        [ItemKinds.Plugin] = "Plugin", [ItemKinds.Template] = "Modèle de note", [ItemKinds.Module] = "Module", [ItemKinds.Notes] = "Notes", [ItemKinds.Agent] = "Agent IA",
    };

    private static readonly Dictionary<string, string> KindPlurals = new()
    {
        [ItemKinds.Plugin] = "Plugins", [ItemKinds.Template] = "Modèles de notes", [ItemKinds.Module] = "Modules", [ItemKinds.Notes] = "Paquets de notes", [ItemKinds.Agent] = "Agents IA",
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

    private static string Permission(string p) =>
        PermissionNames.TryGetValue(p, out string? n) ? n
        : p.StartsWith("network:", StringComparison.Ordinal) ? $"Accéder à Internet : {p["network:".Length..]}" : p;

    /// <summary>Pictogramme et teinte de chaque categorie connue.</summary>
    private static readonly Dictionary<string, (string Glyph, int Hue)> CategoryLooks = new()
    {
        ["organisation"] = ("▦", 200), ["ecriture"] = ("✎", 25), ["productivite"] = ("↯", 45), ["recherche"] = ("⌕", 260),
        ["visualisation"] = ("◔", 170), ["ia"] = ("✦", 285), ["apparence"] = ("◐", 330), ["import-export"] = ("⇄", 145),
        ["collaboration"] = ("⚇", 215), ["enseignement"] = ("✐", 10), ["lecture"] = ("❧", 95), ["developpement"] = ("{}", 235),
    };

    private static (string Glyph, int Hue) LookOf(string slug) =>
        CategoryLooks.TryGetValue(slug, out var l) ? l : (slug[..1].ToUpperInvariant(), Hue(slug));

    private static readonly Dictionary<string, (bool Ok, string Text)> Notices = new()
    {
        ["avis-ok"] = (true, "Merci ! Votre avis est publié."),
        ["avis-retire"] = (true, "Votre avis est retiré."),
        ["reponse-ok"] = (true, "Votre réponse est enregistrée."),
        ["deconnecte"] = (true, "Vous êtes déconnecté."),
        ["avis-invalide"] = (false, "Choisissez une note de 1 à 5 étoiles (et un texte de 4 000 caractères au plus)."),
        ["avis-refuse"] = (false, "Cette action ne vous est pas permise (pas d'avis sur ce que vous publiez)."),
        ["introuvable"] = (false, "Élément ou avis introuvable."),
        ["connexion-indisponible"] = (false, "La connexion n'est pas ouverte sur ce store pour l'instant."),
        ["connexion-echouee"] = (false, "La connexion a échoué. Réessayez."),
        ["session"] = (false, "Votre session a expiré. Réessayez."),
    };

    // ── Mise en forme ──────────────────────────────────────────────────────

    private static int Hue(string s)
    {
        int h = 0;
        foreach (char c in s) h = (h * 31 + c) & 0x7FFFFFFF;
        return h % 360;
    }

    /// <summary>1234567 devient « 1 234 567 » (espace fine insecable).</summary>
    public static string N(long n)
    {
        string s = Math.Abs(n).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var sb = new StringBuilder();
        for (int i = 0; i < s.Length; i++)
        {
            if (i > 0 && (s.Length - i) % 3 == 0) sb.Append(' ');
            sb.Append(s[i]);
        }
        return (n < 0 ? "-" : "") + sb;
    }

    private static string R(double r) => r.ToString("0.0", System.Globalization.CultureInfo.InvariantCulture).Replace('.', ',');

    private static readonly string[] Months = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

    public static string D(DateTime? d) => d is DateTime x ? $"{x.Day} {Months[x.Month - 1]} {x.Year}" : "";

    private static string Iso(DateTime? d) => d?.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture) ?? "";

    private static string Stars(double rating)
    {
        int full = (int)Math.Round(rating);
        return $"<span class=\"stars\" aria-label=\"{R(rating)} sur 5\">{new string('★', full)}<span class=\"off\">{new string('★', 5 - full)}</span></span>";
    }

    private static string Price(PriceDto? p) =>
        p is null ? "<span class=\"price\">Gratuit</span>"
        : $"<span class=\"price\">{(p.Cents / 100.0).ToString("0.00", System.Globalization.CultureInfo.InvariantCulture).Replace('.', ',')} {E(p.Currency == "EUR" ? "€" : p.Currency)}</span>";

    private static string Icon(ItemSummaryDto i, bool big = false) =>
        i.IconId is Guid id
            ? $"<img class=\"icon{(big ? " big" : "")}\" src=\"{U($"/media/{id}")}\" alt=\"\" width=\"{(big ? 92 : 46)}\" height=\"{(big ? 92 : 46)}\">"
            : $"<span class=\"icon letter{(big ? " big" : "")}\" style=\"--h:{Hue(i.Id)}\" aria-hidden=\"true\">{E(i.Name.Length > 0 ? i.Name[..1].ToUpperInvariant() : "?")}</span>";

    private static string ItemUrl(string id) => U($"/items/{Uri.EscapeDataString(id)}");

    private static string Card(ItemSummaryDto i)
    {
        var sb = new StringBuilder();
        sb.Append($"<a class=\"card\" href=\"{ItemUrl(i.Id)}\"><div class=\"card-head\">{Icon(i)}<div><h3>{E(i.Name)}</h3>");
        sb.Append($"<div class=\"meta\">par {E(i.Author)}</div></div></div>");
        sb.Append($"<p class=\"sum\">{E(i.Summary)}</p><div class=\"card-foot\">");
        sb.Append(i.Rating is double r ? $"<span><span class=\"stars\">★</span> {R(r)} <span class=\"muted\">({N(i.RatingCount)})</span></span>" : "<span>Nouveau</span>");
        sb.Append($"<span title=\"Installations\">⤓ {N(i.Downloads)}</span>");
        sb.Append($"<span class=\"kind tag\">{E(KindNames.GetValueOrDefault(i.Kind, i.Kind))}</span></div></a>");
        return sb.ToString();
    }

    private static string Grid(IEnumerable<ItemSummaryDto> items) => "<div class=\"grid\">" + string.Concat(items.Select(Card)) + "</div>";

    private static string CategoryTile(CategoryCountDto c)
    {
        (string glyph, int hue) = LookOf(c.Slug);
        return $"<a class=\"cat\" href=\"{U($"/categories/{Uri.EscapeDataString(c.Slug)}")}\"><span class=\"glyph\" style=\"--h:{hue}\" aria-hidden=\"true\">{E(glyph)}</span>"
            + $"<span><strong>{E(c.Name)}</strong><span class=\"d\">{(c.Description.Length > 0 ? E(c.Description) + " · " : "")}{N(c.Count)} élément{(c.Count > 1 ? "s" : "")}</span></span></a>";
    }

    // ── Gabarit ────────────────────────────────────────────────────────────

    private static string Layout(SiteContext ctx, string title, string description, string body, string? canonical = null, string? active = null, string? image = null)
    {
        string Nav(string href, string label, string key) => $"<a href=\"{U(href)}\"{(active == key ? " aria-current=\"page\"" : "")}>{label}</a>";
        var account = new StringBuilder();
        if (ctx.SignedIn)
        {
            account.Append($"<span class=\"muted\">{E(ctx.UserName)}</span>");
            account.Append($"<form method=\"post\" action=\"{U("/auth/logout")}\"><input type=\"hidden\" name=\"_csrf\" value=\"{E(ctx.Csrf)}\">");
            account.Append($"<input type=\"hidden\" name=\"returnUrl\" value=\"{E(ctx.Path)}\"><button class=\"linkbtn\" type=\"submit\">Se déconnecter</button></form>");
        }
        else if (ctx.LoginEnabled)
            account.Append($"<a class=\"btn small ghost\" href=\"{U("/auth/login?returnUrl=" + Uri.EscapeDataString(ctx.Path))}\" rel=\"nofollow\">Se connecter</a>");
        string notice = ctx.Notice is not null && Notices.TryGetValue(ctx.Notice, out var n)
            ? $"<div class=\"wrap\"><p class=\"notice {(n.Ok ? "ok" : "err")}\" role=\"status\">{E(n.Text)}</p></div>" : "";
        return $"""
            <!doctype html>
            <html lang="fr">
            <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>{E(title)}</title>
            <meta name="description" content="{E(description)}">
            {(canonical is null ? "" : $"<link rel=\"canonical\" href=\"{E(canonical)}\">")}
            <meta property="og:type" content="website">
            <meta property="og:site_name" content="Savoire Store">
            <meta property="og:title" content="{E(title)}">
            <meta property="og:description" content="{E(description)}">
            {(image is null ? "" : $"<meta property=\"og:image\" content=\"{E(image)}\">")}
            <meta name="theme-color" content="#0d9488">
            <link rel="stylesheet" href="{U("/site.css?v=" + SiteStyleVersion)}">
            </head>
            <body>
            <header class="top"><div class="wrap">
            <a class="brand" href="{U("/")}"><span class="logo" aria-hidden="true">S</span>Savoire <small>Store</small></a>
            <nav class="nav" aria-label="Sections">{Nav("/catalogue", "Explorer", "catalogue")}{Nav("/categories", "Catégories", "categories")}{Nav("/publier", "Publier", "publier")}</nav>
            <form class="search" method="get" action="{U("/catalogue")}" role="search"><input type="search" name="q" placeholder="Chercher un plugin, un modèle…" aria-label="Chercher"></form>
            <div class="account">{account}</div>
            </div></header>
            {notice}
            <main>
            {body}
            </main>
            <footer><div class="wrap">
            <span>Savoire Store · paquets signés, vérifiés avant installation</span>
            <nav><a href="{U("/publier")}">Publier un élément</a><a href="{U("/categories")}">Catégories</a><a href="{U("/api/v1/items")}">API</a></nav>
            </div></footer>
            </body>
            </html>
            """;
    }

    /// <summary>Change quand la feuille change : le navigateur la garde un an.</summary>
    public static readonly string SiteStyleVersion = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(SiteStyle.Css)))[..10].ToLowerInvariant();

    // ── Accueil ────────────────────────────────────────────────────────────

    public static string Home(SiteContext ctx, HomeModel m, string canonical)
    {
        var sb = new StringBuilder();
        int total = m.Kinds.Values.Sum();
        sb.Append("<section class=\"hero\"><div class=\"wrap\">");
        sb.Append("<h1>Étendez Savoire à votre façon</h1>");
        sb.Append($"<p class=\"lead\">{N(total)} élément{(total > 1 ? "s" : "")} publié{(total > 1 ? "s" : "")} par la communauté : plugins, modèles de notes, modules et agents IA. Chaque paquet est relu, signé et vérifié avant d'être installé.</p>");
        sb.Append($"<form class=\"bigsearch\" method=\"get\" action=\"{U("/")}\" role=\"search\"><input type=\"search\" name=\"q\" placeholder=\"Kanban, citations, thème sombre…\" aria-label=\"Chercher\" autofocus><button class=\"btn\" type=\"submit\">Chercher</button></form>");
        sb.Append("<div class=\"chips\">");
        foreach ((string kind, string label) in KindPlurals)
            if (m.Kinds.GetValueOrDefault(kind) is int c and > 0)
                sb.Append($"<a class=\"chip\" href=\"{U("/catalogue?kind=" + kind)}\">{E(label)} <span class=\"n\">{N(c)}</span></a>");
        sb.Append("</div></div></section><div class=\"wrap\">");

        if (total == 0)
        {
            sb.Append($"<section class=\"block\"><div class=\"empty\"><p><strong>Le store est encore vide.</strong></p><p>Soyez la première personne à publier : <a href=\"{U("/publier")}\">voici comment</a>.</p></div></section>");
        }
        else
        {
            Rail(sb, "Les plus installés", "/catalogue?sort=popular", m.Popular);
            if (m.Categories.Count > 0)
            {
                sb.Append($"<section class=\"block\"><div class=\"block-head\"><h2>Parcourir par catégorie</h2><a href=\"{U("/categories")}\">Toutes les catégories →</a></div><div class=\"cats\">");
                foreach (CategoryCountDto c in m.Categories.Take(8)) sb.Append(CategoryTile(c));
                sb.Append("</div></section>");
            }
            Rail(sb, "Les mieux notés", "/catalogue?sort=rating", m.TopRated);
            Rail(sb, "Nouveautés", "/catalogue?sort=recent", m.Recent);
        }
        sb.Append("</div>");
        return Layout(ctx, "Savoire Store · plugins, modèles et modules pour Savoire", "Plugins, modèles de notes, modules et agents IA pour Savoire, relus et signés.", sb.ToString(), canonical);
    }

    private static void Rail(StringBuilder sb, string title, string more, IReadOnlyList<ItemSummaryDto> items)
    {
        if (items.Count == 0) return;
        sb.Append($"<section class=\"block\"><div class=\"block-head\"><h2>{E(title)}</h2><a href=\"{U(more)}\">Tout voir →</a></div>");
        sb.Append(Grid(items)).Append("</section>");
    }

    // ── Catalogue ──────────────────────────────────────────────────────────

    /// <summary>L'adresse d'une recherche ; les valeurs par defaut sont omises.</summary>
    public static string CatalogUrl(CatalogQuery q, Category? fixedCategory = null)
    {
        var parts = new List<string>();
        void Add(string key, string? value) { if (!string.IsNullOrWhiteSpace(value)) parts.Add($"{key}={Uri.EscapeDataString(value)}"); }
        Add("q", q.Q);
        Add("kind", q.Kind);
        bool onCategoryPage = fixedCategory is not null && q.Category == fixedCategory.Slug;
        if (!onCategoryPage) Add("category", q.Category);
        Add("price", q.Price);
        Add("minRating", q.MinRating?.ToString(System.Globalization.CultureInfo.InvariantCulture));
        if (q.Sort is not null and not "popular") Add("sort", q.Sort);
        if (q.Page > 1) Add("page", q.Page.ToString(System.Globalization.CultureInfo.InvariantCulture));
        string path = onCategoryPage ? $"/categories/{Uri.EscapeDataString(fixedCategory!.Slug)}" : "/catalogue";
        return path + (parts.Count > 0 ? "?" + string.Join("&", parts) : "");
    }

    public static string Catalog(SiteContext ctx, CatalogModel m, string canonical)
    {
        CatalogQuery q = m.Query;
        string Url(CatalogQuery changed) => U(CatalogUrl(changed with { Page = 1 }, m.FixedCategory));
        var sb = new StringBuilder();
        string title = m.FixedCategory?.Name ?? (q.Kind is not null && KindPlurals.TryGetValue(q.Kind, out string? kp) ? kp : "Explorer le store");
        sb.Append("<div class=\"wrap\"><div class=\"page-head\">");
        if (m.FixedCategory is not null) sb.Append($"<div class=\"crumbs\"><a href=\"{U("/categories")}\">Catégories</a> ›</div>");
        sb.Append($"<h1>{E(title)}</h1>");
        if (m.FixedCategory is { Description.Length: > 0 } fc) sb.Append($"<p class=\"muted\">{E(fc.Description)}</p>");
        sb.Append("</div><div class=\"layout\">");

        // Filtres : des liens, chacun garde les autres choix.
        sb.Append("<aside class=\"filters\" aria-label=\"Filtres\">");
        sb.Append("<h4>Sorte</h4>");
        int allKinds = m.Facets.Kinds.Values.Sum();
        sb.Append($"<a class=\"facet{(q.Kind is null ? " on" : "")}\" href=\"{Url(q with { Kind = null })}\">Tout <span class=\"n\">{N(allKinds)}</span></a>");
        foreach ((string kind, string label) in KindPlurals)
        {
            int c = m.Facets.Kinds.GetValueOrDefault(kind);
            if (c == 0 && q.Kind != kind) continue;
            sb.Append($"<a class=\"facet{(q.Kind == kind ? " on" : "")}\" href=\"{Url(q with { Kind = kind })}\">{E(label)} <span class=\"n\">{N(c)}</span></a>");
        }
        if (m.FixedCategory is null && m.Facets.Categories.Count > 0)
        {
            sb.Append("<h4>Catégorie</h4>");
            sb.Append($"<a class=\"facet{(q.Category is null ? " on" : "")}\" href=\"{Url(q with { Category = null })}\">Toutes</a>");
            foreach (CategoryCountDto c in m.Facets.Categories.Take(14))
                sb.Append($"<a class=\"facet{(q.Category == c.Slug ? " on" : "")}\" href=\"{Url(q with { Category = c.Slug })}\">{E(c.Name)} <span class=\"n\">{N(c.Count)}</span></a>");
        }
        sb.Append("<h4>Prix</h4>");
        sb.Append($"<a class=\"facet{(q.Price is null ? " on" : "")}\" href=\"{Url(q with { Price = null })}\">Tous</a>");
        sb.Append($"<a class=\"facet{(q.Price == "free" ? " on" : "")}\" href=\"{Url(q with { Price = "free" })}\">Gratuits <span class=\"n\">{N(m.Facets.Free)}</span></a>");
        if (m.Facets.Paid > 0 || q.Price == "paid")
            sb.Append($"<a class=\"facet{(q.Price == "paid" ? " on" : "")}\" href=\"{Url(q with { Price = "paid" })}\">Payants <span class=\"n\">{N(m.Facets.Paid)}</span></a>");
        sb.Append("<h4>Note</h4>");
        sb.Append($"<a class=\"facet{(q.MinRating is null ? " on" : "")}\" href=\"{Url(q with { MinRating = null })}\">Toutes</a>");
        foreach (int r in new[] { 4, 3 })
            sb.Append($"<a class=\"facet{(q.MinRating == r ? " on" : "")}\" href=\"{Url(q with { MinRating = r })}\"><span><span class=\"stars\">{new string('★', r)}</span> et plus</span></a>");
        sb.Append("</aside>");

        // Resultats.
        sb.Append("<div>");
        sb.Append($"<div class=\"toolbar\"><form method=\"get\" action=\"{U(m.FixedCategory is null ? "/catalogue" : $"/categories/{Uri.EscapeDataString(m.FixedCategory.Slug)}")}\" role=\"search\">");
        sb.Append($"<input type=\"search\" name=\"q\" value=\"{E(q.Q)}\" placeholder=\"Chercher…\" aria-label=\"Chercher\">");
        void Hidden(string name, string? value) { if (!string.IsNullOrWhiteSpace(value)) sb.Append($"<input type=\"hidden\" name=\"{name}\" value=\"{E(value)}\">"); }
        Hidden("kind", q.Kind);
        if (m.FixedCategory is null) Hidden("category", q.Category);
        Hidden("price", q.Price);
        Hidden("minRating", q.MinRating?.ToString(System.Globalization.CultureInfo.InvariantCulture));
        Hidden("sort", q.Sort);
        sb.Append("<button class=\"btn\" type=\"submit\">Chercher</button></form>");
        sb.Append("<nav class=\"seg\" aria-label=\"Trier\">");
        foreach ((string s, string label) in new[] { ("popular", "Populaires"), ("rating", "Mieux notés"), ("recent", "Récents"), ("name", "A → Z") })
            sb.Append($"<a class=\"{((q.Sort ?? "popular") == s ? "on" : "")}\" href=\"{Url(q with { Sort = s })}\">{label}</a>");
        sb.Append("</nav></div>");

        var chips = new List<string>();
        if (!string.IsNullOrWhiteSpace(q.Q)) chips.Add($"<a href=\"{Url(q with { Q = null })}\" title=\"Retirer\">« {E(q.Q)} »</a>");
        if (q.Kind is not null) chips.Add($"<a href=\"{Url(q with { Kind = null })}\" title=\"Retirer\">{E(KindPlurals.GetValueOrDefault(q.Kind, q.Kind))}</a>");
        if (q.Category is not null && m.FixedCategory is null) chips.Add($"<a href=\"{Url(q with { Category = null })}\" title=\"Retirer\">{E(Categories.Of(q.Category).Name)}</a>");
        if (q.Price is not null) chips.Add($"<a href=\"{Url(q with { Price = null })}\" title=\"Retirer\">{(q.Price == "free" ? "Gratuits" : "Payants")}</a>");
        if (q.MinRating is int mr) chips.Add($"<a href=\"{Url(q with { MinRating = null })}\" title=\"Retirer\">{mr} étoiles et plus</a>");
        sb.Append($"<div class=\"active\"><span class=\"meta\">{N(m.Page.Total)} résultat{(m.Page.Total > 1 ? "s" : "")}</span>{string.Concat(chips)}</div>");

        if (m.Page.Items.Count == 0)
            sb.Append($"<div class=\"empty\"><p><strong>Rien trouvé.</strong></p><p>Essayez d'autres mots, ou <a href=\"{U("/catalogue")}\">retirez les filtres</a>.</p></div>");
        else sb.Append(Grid(m.Page.Items));

        int pages = (m.Page.Total + m.Page.PageSize - 1) / m.Page.PageSize;
        if (pages > 1)
        {
            sb.Append("<nav class=\"pager\" aria-label=\"Pages\">");
            string P(int p) => U(CatalogUrl(q with { Page = p }, m.FixedCategory));
            if (m.Page.Page > 1) sb.Append($"<a href=\"{P(m.Page.Page - 1)}\" rel=\"prev\">‹</a>");
            int last = 0;
            for (int p = 1; p <= pages; p++)
            {
                if (p != 1 && p != pages && Math.Abs(p - m.Page.Page) > 2) continue;
                if (last != 0 && p - last > 1) sb.Append("<span class=\"gap\">…</span>");
                sb.Append(p == m.Page.Page ? $"<span class=\"on\" aria-current=\"page\">{p}</span>" : $"<a href=\"{P(p)}\">{p}</a>");
                last = p;
            }
            if (m.Page.Page < pages) sb.Append($"<a href=\"{P(m.Page.Page + 1)}\" rel=\"next\">›</a>");
            sb.Append("</nav>");
        }
        sb.Append("</div></div></div>");
        string description = m.FixedCategory is not null
            ? $"{m.FixedCategory.Name} : plugins, modèles et modules pour Savoire. {m.FixedCategory.Description}"
            : "Chercher parmi les plugins, modèles de notes, modules et agents IA de Savoire.";
        return Layout(ctx, $"{title} · Savoire Store", description, sb.ToString(), canonical, m.FixedCategory is null ? "catalogue" : "categories");
    }

    // ── Categories ─────────────────────────────────────────────────────────

    public static string CategoriesPage(SiteContext ctx, IReadOnlyList<CategoryCountDto> categories, string canonical)
    {
        var sb = new StringBuilder("<div class=\"wrap\"><div class=\"page-head\"><h1>Catégories</h1><p class=\"muted\">Tout ce que la communauté a publié, rangé par usage.</p></div>");
        if (categories.Count == 0) sb.Append("<div class=\"empty\">Pas encore de catégorie.</div>");
        else sb.Append("<div class=\"cats\">").Append(string.Concat(categories.Select(CategoryTile))).Append("</div>");
        sb.Append("</div>");
        return Layout(ctx, "Catégories · Savoire Store", "Les catégories du Savoire Store.", sb.ToString(), canonical, "categories");
    }

    // ── Fiche ──────────────────────────────────────────────────────────────

    public static string Item(SiteContext ctx, ItemModel m)
    {
        ItemDetailDto d = m.Detail;
        ItemSummaryDto i = d.Item;
        string kind = KindNames.GetValueOrDefault(i.Kind, i.Kind);
        IReadOnlyList<ScreenshotDto> shots = d.Screenshots ?? [];
        var sb = new StringBuilder("<div class=\"wrap\">");
        sb.Append($"<div class=\"crumbs\"><a href=\"{U("/catalogue")}\">Explorer</a> › <a href=\"{U("/catalogue?kind=" + i.Kind)}\">{E(KindPlurals.GetValueOrDefault(i.Kind, kind))}</a> ›</div>");

        // En-tete : icone, nom, faits, installation.
        sb.Append($"<div class=\"item-hero\">{Icon(i, big: true)}<div><h1>{E(i.Name)}</h1><p class=\"lead\">{E(i.Summary)}</p><div class=\"facts\">");
        sb.Append($"<span>par <a href=\"{U("/catalogue?q=" + Uri.EscapeDataString(i.Author))}\">{E(i.Author)}</a></span>");
        sb.Append(i.Rating is double r
            ? $"<a href=\"#avis\" style=\"text-decoration:none;color:inherit\">{Stars(r)} <b>{R(r)}</b> ({N(i.RatingCount)} avis)</a>"
            : "<a href=\"#avis\">Pas encore d'avis</a>");
        sb.Append($"<span><b>{N(i.Downloads)}</b> installation{(i.Downloads > 1 ? "s" : "")}</span>");
        sb.Append($"<span>Version <b>{E(i.LatestVersion)}</b></span>");
        sb.Append($"<span class=\"tag\">{E(kind)}</span>");
        foreach (string c in i.Categories) sb.Append($"<a class=\"tag\" href=\"{U($"/categories/{Uri.EscapeDataString(c)}")}\">{E(Categories.Of(c).Name)}</a>");
        sb.Append("</div></div><div class=\"cta\">");
        sb.Append($"<div style=\"text-align:center;font-size:20px\">{Price(i.Price)}</div>");
        if (ctx.AppUrl is { Length: > 0 } app) sb.Append($"<a class=\"btn\" href=\"{E(app)}\">Ouvrir Savoire pour l'installer</a>");
        sb.Append($"<span class=\"hint\">Dans Savoire : <em>Paramètres → Store</em>, cherchez « {E(i.Name)} ». Le paquet est vérifié avant l'installation.</span>");
        sb.Append($"<a class=\"btn ghost small\" href=\"https://github.com/{E(d.Repo)}\" rel=\"nofollow noopener\">Code source</a>");
        sb.Append("</div></div>");

        // Onglets (ancres).
        sb.Append("<nav class=\"tabs\" aria-label=\"Sur cette page\">");
        sb.Append("<a href=\"#presentation\">Présentation</a>");
        sb.Append(i.Kind == ItemKinds.Agent ? "<a href=\"#droits\">Droits et consignes</a>" : "<a href=\"#droits\">Droits</a>");
        sb.Append($"<a href=\"#versions\">Versions ({d.Versions.Count})</a><a href=\"#avis\">Avis ({N(i.RatingCount)})</a></nav>");

        sb.Append("<div class=\"item-layout\"><div>");

        // Captures et description.
        sb.Append("<section id=\"presentation\">");
        if (shots.Count > 0)
        {
            sb.Append("<div class=\"gallery\" id=\"galerie\">");
            for (int k = 0; k < shots.Count; k++)
            {
                ScreenshotDto s = shots[k];
                string alt = s.Caption ?? $"Capture {k + 1} de {i.Name}";
                sb.Append($"<a class=\"shot\" href=\"#capture-{k + 1}\"><img src=\"{U($"/media/{s.Id}")}\" alt=\"{E(alt)}\" width=\"{s.Width}\" height=\"{s.Height}\"{(k > 0 ? " loading=\"lazy\"" : "")}>");
                if (s.Caption is not null) sb.Append($"<span>{E(s.Caption)}</span>");
                sb.Append("</a>");
            }
            sb.Append("</div>");
        }
        string description = Markdown.ToHtml(d.Description != i.Summary ? d.Description : "", 1, Base);
        sb.Append(description.Length > 0 ? $"<div class=\"prose\">{description}</div>" : $"<div class=\"prose\"><p>{E(i.Summary)}</p></div>");
        sb.Append("</section>");

        // Droits.
        sb.Append("<section id=\"droits\">");
        if (i.Kind == ItemKinds.Agent)
        {
            if (d.Agent is not null) AgentSection(sb, d.Agent);
        }
        else
        {
            sb.Append("<h2>Droits demandés</h2>");
            if (d.Permissions.Count == 0) sb.Append("<p class=\"muted\">Aucun droit particulier : il ne lit ni ne modifie vos notes, et n'accède pas à Internet.</p>");
            else
            {
                sb.Append("<ul class=\"checks\">");
                foreach (string p in d.Permissions) sb.Append($"<li>{E(Permission(p))}</li>");
                sb.Append("</ul><p class=\"note\">Savoire vous les montre encore avant d'installer.</p>");
            }
        }
        if (i.Kind == ItemKinds.Plugin)
        {
            sb.Append("<h2>Fonctionne avec</h2>");
            IReadOnlyList<string> caps = d.Capabilities ?? [];
            if (caps.Count == 0) sb.Append("<p class=\"muted\">Le plugin n'annonce aucun système de Savoire.</p>");
            else
            {
                sb.Append("<ul class=\"checks\">");
                foreach (string c in caps) sb.Append($"<li>{E(Publishing.PackageChecks.Capabilities.GetValueOrDefault(c, c))}</li>");
                sb.Append("</ul>");
            }
            sb.Append(d.Runtime == "frame"
                ? "<p class=\"note\">Tourne dans un cadre isolé, avec une API réduite.</p>"
                : "<p class=\"note\">Tourne dans Savoire, avec toute l'API, sur votre appareil seulement (jamais sur le serveur).</p>");
        }
        sb.Append("</section>");

        // Versions.
        sb.Append("<section id=\"versions\"><h2>Versions</h2><table class=\"versions\"><thead><tr><th>Version</th><th>Publiée le</th><th>Savoire requis</th></tr></thead><tbody>");
        foreach (VersionDto v in d.Versions.Take(15))
            sb.Append($"<tr><td><b>{E(v.Version)}</b>{(v.Version == i.LatestVersion ? " <span class=\"tag\">actuelle</span>" : "")}</td><td><time datetime=\"{Iso(v.PublishedAt)}\">{D(v.PublishedAt)}</time></td><td>{(v.MinAppVersion is null ? "<span class=\"muted\">toutes</span>" : E(v.MinAppVersion) + " ou plus")}</td></tr>");
        sb.Append("</tbody></table>");
        if (d.Versions.Count > 15) sb.Append($"<p class=\"note\">Et {d.Versions.Count - 15} versions plus anciennes.</p>");
        sb.Append("</section>");

        Reviews(sb, ctx, m);
        sb.Append("</div>");

        // Colonne : informations, elements proches.
        sb.Append("<aside><div class=\"panel\"><h3>Informations</h3><dl class=\"info\">");
        sb.Append($"<dt>Éditeur</dt><dd>{E(i.Author)}</dd>");
        sb.Append($"<dt>Sorte</dt><dd>{E(kind)}</dd>");
        sb.Append($"<dt>Version</dt><dd>{E(i.LatestVersion)}</dd>");
        sb.Append($"<dt>Mise à jour</dt><dd>{D(i.UpdatedAt)}</dd>");
        if (d.License is not null) sb.Append($"<dt>Licence</dt><dd>{E(d.License)}</dd>");
        sb.Append($"<dt>Source</dt><dd><a href=\"https://github.com/{E(d.Repo)}\" rel=\"nofollow noopener\">{E(d.Repo)}</a></dd>");
        if (d.Homepage is not null && d.Homepage.StartsWith("https://", StringComparison.Ordinal))
            sb.Append($"<dt>Site</dt><dd><a href=\"{E(d.Homepage)}\" rel=\"nofollow noopener\">{E(d.Homepage.Replace("https://", ""))}</a></dd>");
        sb.Append($"<dt>Identifiant</dt><dd><code>{E(i.Id)}</code></dd>");
        sb.Append("</dl></div>");
        if (m.Related.Count > 0)
        {
            sb.Append("<div class=\"panel\"><h3>Dans la même veine</h3><div style=\"display:grid;gap:12px\">");
            foreach (ItemSummaryDto o in m.Related)
                sb.Append($"<a href=\"{ItemUrl(o.Id)}\" style=\"display:flex;gap:10px;align-items:center;text-decoration:none;color:inherit\">{Icon(o)}<span><strong style=\"display:block\">{E(o.Name)}</strong><span class=\"meta\">{(o.Rating is double rr ? $"★ {R(rr)} · " : "")}{N(o.Downloads)} installations</span></span></a>");
            sb.Append("</div></div>");
        }
        sb.Append("</aside></div>");

        // Captures en grand (:target).
        for (int k = 0; k < shots.Count; k++)
        {
            ScreenshotDto s = shots[k];
            sb.Append($"<div class=\"lightbox\" id=\"capture-{k + 1}\" role=\"dialog\" aria-label=\"Capture {k + 1}\"><a class=\"close\" href=\"#galerie\" aria-label=\"Fermer\"></a><figure>");
            sb.Append($"<img src=\"{U($"/media/{s.Id}")}\" alt=\"{E(s.Caption ?? $"Capture {k + 1}")}\" loading=\"lazy\">");
            sb.Append($"<figcaption>{E(s.Caption ?? "")} <span style=\"opacity:.6\">{k + 1} / {shots.Count}</span></figcaption><div class=\"lb-nav\">");
            if (k > 0) sb.Append($"<a href=\"#capture-{k}\">‹ Précédente</a>");
            sb.Append("<a href=\"#galerie\">Fermer</a>");
            if (k + 1 < shots.Count) sb.Append($"<a href=\"#capture-{k + 2}\">Suivante ›</a>");
            sb.Append("</div></figure></div>");
        }
        sb.Append("</div>");
        string? image = shots.Count > 0 ? AbsoluteFrom(m.Canonical, $"/media/{shots[0].Id}") : null;
        return Layout(ctx, $"{i.Name} · {kind} pour Savoire", i.Summary, sb.ToString(), m.Canonical, image: image);
    }

    /// <summary>Une adresse absolue sur le meme site que `canonical` (pour og:image).</summary>
    private static string? AbsoluteFrom(string canonical, string path) =>
        Uri.TryCreate(canonical, UriKind.Absolute, out Uri? u) ? $"{u.Scheme}://{u.Authority}{Base}{path}" : null;

    private static void Reviews(StringBuilder sb, SiteContext ctx, ItemModel m)
    {
        ItemSummaryDto i = m.Detail.Item;
        string itemPath = $"/items/{Uri.EscapeDataString(i.Id)}";
        sb.Append($"<section id=\"avis\"><h2>Avis</h2>");
        if (i.Rating is double r)
        {
            sb.Append($"<div class=\"rating-sum\"><div><div class=\"big\">{R(r)}</div>{Stars(r)}<div class=\"meta\">{N(i.RatingCount)} avis</div></div><div class=\"bars\">");
            int max = Math.Max(1, m.Distribution.Max());
            for (int s = 5; s >= 1; s--)
            {
                int c = m.Distribution[s - 1];
                sb.Append($"<div class=\"bar\"><span>{s} ★</span><span class=\"track\"><span class=\"fill\" style=\"display:block;width:{c * 100 / max}%\"></span></span><span>{N(c)}</span></div>");
            }
            sb.Append("</div></div>");
        }

        // Donner son avis.
        if (!ctx.SignedIn)
        {
            sb.Append("<div class=\"login-box\"><span>Vous utilisez cet élément ? Donnez votre avis avec votre compte Savoire.</span>");
            sb.Append(ctx.LoginEnabled
                ? $"<a class=\"btn\" href=\"{U("/auth/login?returnUrl=" + Uri.EscapeDataString(itemPath + "#avis"))}\" rel=\"nofollow\">Se connecter pour donner un avis</a>"
                : "<span class=\"muted\">Depuis l'application Savoire.</span>");
            sb.Append("</div>");
        }
        else if (m.IsPublisher)
            sb.Append("<p class=\"note\">Vous publiez cet élément : vous pouvez répondre aux avis, pas en donner.</p>");
        else
        {
            ReviewDto? mine = m.Mine;
            sb.Append($"<form class=\"review-form\" method=\"post\" action=\"{U(itemPath + "/avis")}\"><input type=\"hidden\" name=\"_csrf\" value=\"{E(ctx.Csrf)}\">");
            sb.Append($"<h3>{(mine is null ? "Votre avis" : "Modifier votre avis")}</h3>");
            sb.Append("<fieldset class=\"star-input\"><legend class=\"sr\">Votre note</legend>");
            for (int s = 5; s >= 1; s--)
                sb.Append($"<input type=\"radio\" name=\"rating\" id=\"note-{s}\" value=\"{s}\"{(mine?.Rating == s ? " checked" : "")}{(s == 5 ? " required" : "")}><label for=\"note-{s}\" title=\"{s} sur 5\">★<span class=\"sr\">{s} sur 5</span></label>");
            sb.Append("</fieldset>");
            sb.Append($"<label class=\"sr\" for=\"avis-texte\">Votre commentaire</label><textarea id=\"avis-texte\" name=\"text\" maxlength=\"{ReviewEndpoints.MaxText}\" placeholder=\"Ce qui vous plaît, ce qui manque… (facultatif)\">{E(mine?.Text)}</textarea>");
            sb.Append($"<div class=\"row\"><button class=\"btn\" type=\"submit\">{(mine is null ? "Publier mon avis" : "Mettre à jour")}</button><span class=\"note\">Publié sous le nom « {E(ctx.UserName)} ». Un avis par version majeure.</span></div></form>");
        }

        // La liste.
        if (m.Reviews.Count == 0) sb.Append("<p class=\"muted\" style=\"margin-top:18px\">Pas encore d'avis.</p>");
        else
        {
            sb.Append("<div style=\"margin-top:10px\">");
            foreach (ReviewDto rv in m.Reviews)
            {
                string initial = rv.UserName.Length > 0 ? rv.UserName[..1].ToUpperInvariant() : "?";
                sb.Append($"<article class=\"review\" id=\"avis-{rv.Id}\"><span class=\"avatar\" style=\"--h:{Hue(rv.UserName)}\" aria-hidden=\"true\">{E(initial)}</span><div>");
                sb.Append($"<div class=\"who\"><strong>{E(rv.UserName)}</strong>{Stars(rv.Rating)}<span class=\"meta\"><time datetime=\"{Iso(rv.UpdatedAt)}\">{D(rv.UpdatedAt)}</time> · version {rv.MajorVersion}.x</span>");
                if (rv.Mine) sb.Append("<span class=\"mine\">Votre avis</span>");
                sb.Append("</div>");
                if (rv.Text.Length > 0) sb.Append($"<p>{E(rv.Text)}</p>");
                if (rv.Reply is not null) sb.Append($"<div class=\"reply\"><div class=\"meta\">Réponse de l'éditeur · {D(rv.ReplyAt)}</div><p>{E(rv.Reply)}</p></div>");
                bool canDelete = ctx.SignedIn && (rv.Mine || ctx.IsAdmin);
                if (canDelete || m.IsPublisher)
                {
                    sb.Append("<div class=\"actions\">");
                    if (canDelete)
                        sb.Append($"<form method=\"post\" action=\"{U($"{itemPath}/avis/{rv.Id}/retirer")}\"><input type=\"hidden\" name=\"_csrf\" value=\"{E(ctx.Csrf)}\"><button class=\"linkbtn\" type=\"submit\">Retirer {(rv.Mine ? "mon" : "cet")} avis</button></form>");
                    if (m.IsPublisher)
                    {
                        sb.Append($"<details class=\"reply-form\"><summary>{(rv.Reply is null ? "Répondre" : "Modifier la réponse")}</summary>");
                        sb.Append($"<form method=\"post\" action=\"{U($"{itemPath}/avis/{rv.Id}/reponse")}\"><input type=\"hidden\" name=\"_csrf\" value=\"{E(ctx.Csrf)}\">");
                        sb.Append($"<textarea name=\"text\" maxlength=\"{ReviewEndpoints.MaxText}\" aria-label=\"Votre réponse\">{E(rv.Reply)}</textarea><div><button class=\"btn small\" type=\"submit\">Enregistrer</button> <span class=\"note\">Vide : retire la réponse.</span></div></form></details>");
                    }
                    sb.Append("</div>");
                }
                sb.Append("</div></article>");
            }
            sb.Append("</div>");
            int pages = (i.RatingCount + ReviewEndpoints.PageSize - 1) / ReviewEndpoints.PageSize;
            if (pages > 1)
            {
                sb.Append("<nav class=\"pager\" aria-label=\"Pages des avis\">");
                for (int p = 1; p <= pages; p++)
                    sb.Append(p == m.ReviewPage ? $"<span class=\"on\">{p}</span>" : $"<a href=\"{U(itemPath + (p > 1 ? $"?avis={p}" : ""))}#avis\">{p}</a>");
                sb.Append("</nav>");
            }
        }
        sb.Append("</section>");
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
        if (a.Rights.Count == 0) sb.Append("<p class=\"muted\">Aucun droit : l'agent ne peut rien faire.</p>");
        else
        {
            sb.Append("<ul class=\"checks\">");
            foreach ((string action, string mode) in a.Rights)
                sb.Append($"<li>{E(ActionNames.GetValueOrDefault(action, action))} : {E(ModeNames.GetValueOrDefault(mode, mode))}</li>");
            sb.Append("</ul>");
        }
        sb.Append("<p class=\"note\">Savoire borne toujours l'agent par vos propres droits. ");
        sb.Append(a.VaultScoped ? "Agent conseillé pour un vault (partagé par ses membres)." : "Agent personnel.");
        if (a.Budget.Count > 0)
            sb.Append(" Budget : " + string.Join(", ", a.Budget.Select(b => $"{E(b.Key)} {b.Value}")) + ".");
        sb.Append("</p>");
        if (a.Instructions.Length > 0) sb.Append($"<h2>Consignes de l'agent</h2><div class=\"prose\"><pre>{E(a.Instructions)}</pre></div>");
    }

    // ── Autres pages ───────────────────────────────────────────────────────

    public static string Document(SiteContext ctx, string title, string markdown, string canonical, string active)
    {
        string html = Markdown.ToHtml(markdown, 0, Base);
        return Layout(ctx, $"{title} · Savoire Store", title, $"<div class=\"wrap\" style=\"max-width:860px;padding-top:28px;padding-bottom:40px\"><div class=\"prose\">{html}</div></div>", canonical, active);
    }

    public static string NotFound(SiteContext ctx) =>
        Layout(ctx, "Introuvable · Savoire Store", "",
            $"<div class=\"wrap\"><div class=\"empty\" style=\"margin-top:40px\"><h1>Introuvable</h1><p>Cette page n'existe pas, ou l'élément a été retiré.</p><p><a class=\"btn\" href=\"{U("/catalogue")}\">Explorer le store</a></p></div></div>");
}
