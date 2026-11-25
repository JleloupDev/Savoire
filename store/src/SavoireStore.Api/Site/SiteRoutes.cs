// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les routes du site (pages, formulaires d'avis, feuille de style, robots.txt,
// sitemap.xml). Les formulaires portent un jeton anti-CSRF et le cookie de
// connexion est SameSite=Lax ; apres un envoi, on revient sur la fiche (303).
using System.Reflection;
using System.Text;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.EntityFrameworkCore;
using SavoireStore.Api;
using SavoireStore.Auth;
using SavoireStore.Data;

namespace SavoireStore.Site;

public static class SiteRoutes
{
    private static readonly Lazy<string> PublishDoc = new(() =>
    {
        using Stream? s = Assembly.GetExecutingAssembly().GetManifestResourceStream("publier.md");
        return s is null ? Fallback : new StreamReader(s).ReadToEnd();
    });

    private const string Fallback = """
        # Publier sur le Savoire Store

        Comme pour Obsidian : votre code vit sur GitHub, le store lit vos releases.

        1. Un dépôt GitHub public, un élément par dépôt.
        2. Une **release** dont le tag est la version (`1.2.0`), avec `manifest.json` et les fichiers du paquet en pièces jointes
           (`main.js` pour un plugin, `template.md` pour un modèle, `module.md` pour un module, `notes.zip` pour des notes).
        3. Facultatif : `icon` et `screenshots` dans le manifeste, des images PNG, JPEG ou WebP de la release.
        4. Avec votre compte Savoire : `POST /api/v1/publish { "repo": "vous/depot" }`.

        La première version de chaque élément est relue avant d'entrer au catalogue.
        """;

    public static void Map(WebApplication app)
    {
        app.MapGet("/site.css", (HttpResponse response) =>
        {
            response.Headers.CacheControl = "public, max-age=31536000, immutable";
            return Results.Text(SiteStyle.Css, "text/css; charset=utf-8");
        });

        app.MapGet("/", async (HttpContext http, StoreDb db, string? q, string? kind, string? category, string? price, int? minRating, string? sort, int? page, string? n, CancellationToken ct) =>
        {
            // Une recherche (la grande barre de l'accueil, et les anciennes adresses « /?q=... ») : le catalogue.
            if (q is not null || kind is not null || category is not null || price is not null || minRating is not null || sort is not null || page is not null)
                return await CatalogAsync(http, db, Query(q, kind, category, price, minRating, sort, page), null, n, ct);
            SiteContext ctx = Context(http, n);
            var model = new HomeModel(
                (await CatalogEndpoints.SearchAsync(db, new CatalogQuery(Sort: "popular", PageSize: 8), ct)).Items,
                (await CatalogEndpoints.SearchAsync(db, new CatalogQuery(Sort: "rating", MinRating: 1, PageSize: 4), ct)).Items,
                (await CatalogEndpoints.SearchAsync(db, new CatalogQuery(Sort: "recent", PageSize: 4), ct)).Items,
                await CatalogEndpoints.CategoriesAsync(db, ct),
                (await CatalogEndpoints.FacetsAsync(db, new CatalogQuery(), ct)).Kinds);
            return Html(http, SitePages.Home(ctx, model, Canonical(http, "/")));
        });

        app.MapGet("/catalogue", async (HttpContext http, StoreDb db, string? q, string? kind, string? category, string? price, int? minRating, string? sort, int? page, string? n, CancellationToken ct) =>
            await CatalogAsync(http, db, Query(q, kind, category, price, minRating, sort, page), null, n, ct));

        app.MapGet("/categories", async (HttpContext http, StoreDb db, CancellationToken ct) =>
            Html(http, SitePages.CategoriesPage(Context(http, null), await CatalogEndpoints.CategoriesAsync(db, ct), Canonical(http, "/categories"))));

        app.MapGet("/categories/{slug}", async (HttpContext http, StoreDb db, string slug, string? q, string? kind, string? price, int? minRating, string? sort, int? page, CancellationToken ct) =>
        {
            string s = Categories.Slug(slug);
            if (s.Length == 0) return Html(http, SitePages.NotFound(Context(http, null)), 404);
            return await CatalogAsync(http, db, Query(q, kind, s, price, minRating, sort, page), Categories.Of(s), null, ct);
        });

        app.MapGet("/items/{id}", async (HttpContext http, StoreDb db, string id, int? avis, string? n, CancellationToken ct) =>
        {
            SiteContext ctx = Context(http, n);
            ItemDetailDto? d = await CatalogEndpoints.DetailAsync(db, id, ct);
            if (d is null) return Html(http, SitePages.NotFound(ctx), 404);
            int reviewPage = Math.Max(1, avis ?? 1);
            List<ReviewDto> reviews = await ReviewEndpoints.ListAsync(db, id, ctx.UserId, reviewPage, ct);
            int[] distribution = await ReviewEndpoints.DistributionAsync(db, id, ct);
            ReviewDto? mine = ctx.UserId is null ? null : await ReviewEndpoints.MineAsync(db, id, ctx.UserId, d.Item.LatestVersion, ct);
            bool publisher = ctx.UserId is not null && await db.Items.AnyAsync(i => i.Id == id && i.PublisherId == ctx.UserId, ct);
            List<ItemSummaryDto> related = await CatalogEndpoints.RelatedAsync(db, d.Item, 4, ct);
            var model = new ItemModel(d, reviews, reviewPage, distribution, mine, publisher, related, Canonical(http, $"/items/{Uri.EscapeDataString(id)}"));
            return Html(http, SitePages.Item(ctx, model));
        });

        app.MapGet("/publier", (HttpContext http) =>
            Html(http, SitePages.Document(Context(http, null), "Publier sur le Savoire Store", PublishDoc.Value, Canonical(http, "/publier"), "publier")));

        // Avis : donner, retirer, repondre (editeur).
        app.MapPost("/items/{id}/avis", (HttpContext http, StoreDb db, StoreUsers users, IAntiforgery af, string id, CancellationToken ct) =>
            FormAsync(http, af, users, id, async (user, form) =>
            {
                int rating = int.TryParse(form["rating"], out int r) ? r : 0;
                return await ReviewEndpoints.UpsertAsync(db, user, id, rating, form["text"], ct);
            }, "avis-ok")).RequireRateLimiting(Program.WritesPolicy);

        app.MapPost("/items/{id}/avis/{reviewId:guid}/retirer", (HttpContext http, StoreDb db, StoreUsers users, IAntiforgery af, string id, Guid reviewId, CancellationToken ct) =>
            FormAsync(http, af, users, id, (user, _) => ReviewEndpoints.DeleteAsync(db, user, id, reviewId, ct), "avis-retire"))
            .RequireRateLimiting(Program.WritesPolicy);

        app.MapPost("/items/{id}/avis/{reviewId:guid}/reponse", (HttpContext http, StoreDb db, StoreUsers users, IAntiforgery af, string id, Guid reviewId, CancellationToken ct) =>
            FormAsync(http, af, users, id, (user, form) => ReviewEndpoints.ReplyAsync(db, user, id, reviewId, form["text"], ct), "reponse-ok"))
            .RequireRateLimiting(Program.WritesPolicy);

        app.MapGet("/robots.txt", (HttpContext http) =>
            Results.Text($"User-agent: *\nDisallow: {http.Request.PathBase}/auth/\nDisallow: {http.Request.PathBase}/api/\nSitemap: {Canonical(http, "/sitemap.xml")}\n", "text/plain; charset=utf-8"));

        app.MapGet("/sitemap.xml", async (HttpContext http, StoreDb db, CancellationToken ct) =>
        {
            var items = await db.Items.AsNoTracking().Where(i => i.Status == ItemStatus.Listed)
                .OrderBy(i => i.Id).Select(i => new { i.Id, i.UpdatedAt }).Take(50_000).ToListAsync(ct);
            List<CategoryCountDto> categories = await CatalogEndpoints.CategoriesAsync(db, ct);
            var sb = new StringBuilder("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n");
            void Url(string path, DateTime? modified = null)
            {
                sb.Append("<url><loc>").Append(System.Security.SecurityElement.Escape(Canonical(http, path))).Append("</loc>");
                if (modified is DateTime m) sb.Append("<lastmod>").Append(m.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture)).Append("</lastmod>");
                sb.Append("</url>\n");
            }
            Url("/");
            Url("/catalogue");
            Url("/categories");
            Url("/publier");
            foreach (CategoryCountDto c in categories) Url($"/categories/{Uri.EscapeDataString(c.Slug)}");
            foreach (var i in items) Url($"/items/{Uri.EscapeDataString(i.Id)}", i.UpdatedAt);
            sb.Append("</urlset>\n");
            return Results.Text(sb.ToString(), "application/xml; charset=utf-8");
        });
    }

    private static CatalogQuery Query(string? q, string? kind, string? category, string? price, int? minRating, string? sort, int? page) => new(
        string.IsNullOrWhiteSpace(q) ? null : q.Trim(),
        kind is not null && ItemKinds.All.Contains(kind) ? kind : null,
        string.IsNullOrWhiteSpace(category) ? null : Categories.Slug(category) is { Length: > 0 } c ? c : null,
        price is "free" or "paid" ? price : null,
        minRating is >= 1 and <= 5 ? minRating : null,
        sort is not null && CatalogEndpoints.Sorts.Contains(sort) ? sort : null,
        Math.Clamp(page ?? 1, 1, 10_000),
        24);

    private static async Task<IResult> CatalogAsync(HttpContext http, StoreDb db, CatalogQuery query, Category? fixedCategory, string? notice, CancellationToken ct)
    {
        ItemPageDto page = await CatalogEndpoints.SearchAsync(db, query, ct);
        FacetsDto facets = await CatalogEndpoints.FacetsAsync(db, query, ct);
        string canonical = Canonical(http, SitePages.CatalogUrl(query with { Q = null, Price = null, MinRating = null, Sort = null }, fixedCategory));
        return Html(http, SitePages.Catalog(Context(http, notice), new CatalogModel(page, facets, query, fixedCategory), canonical));
    }

    /// <summary>
    /// Un formulaire d'avis : compte connecte (sinon, la connexion, puis
    /// retour sur la fiche), jeton anti-CSRF valide, puis retour sur la fiche
    /// avec un message.
    /// </summary>
    private static async Task<IResult> FormAsync(HttpContext http, IAntiforgery af, StoreUsers users, string id,
        Func<StoreUser, IFormCollection, Task<ReviewOutcome>> action, string okNotice)
    {
        string home = http.Request.PathBase.Value ?? "";
        string itemPath = $"/items/{Uri.EscapeDataString(id)}";
        if (http.User.FindFirst("sub") is null)
            return Results.Redirect($"{home}/auth/login?returnUrl={Uri.EscapeDataString(itemPath + "#avis")}", preserveMethod: false);
        if (!http.Request.HasFormContentType || !await af.IsRequestValidAsync(http))
            return Results.Redirect($"{home}{itemPath}?n=session#avis");
        IFormCollection form = await http.Request.ReadFormAsync();
        ReviewOutcome outcome = await action(users.FromClaims(http.User), form);
        string notice = outcome.Ok ? okNotice : outcome.Status switch { 403 => "avis-refuse", 404 => "introuvable", _ => "avis-invalide" };
        return new SeeOther($"{home}{itemPath}?n={notice}#avis");
    }

    private sealed class SeeOther(string url) : IResult
    {
        public Task ExecuteAsync(HttpContext http)
        {
            http.Response.StatusCode = StatusCodes.Status303SeeOther;
            http.Response.Headers.Location = url;
            return Task.CompletedTask;
        }
    }

    private static SiteContext Context(HttpContext http, string? notice)
    {
        IConfiguration config = http.RequestServices.GetRequiredService<IConfiguration>();
        string path = http.Request.Path.Value ?? "/";
        // Le message ne suit pas dans l'adresse de retour.
        string query = string.Join("&", http.Request.Query.Where(q => q.Key != "n").Select(q => $"{Uri.EscapeDataString(q.Key)}={Uri.EscapeDataString(q.Value.ToString())}"));
        string current = query.Length > 0 ? $"{path}?{query}" : path;
        string? sub = http.User.FindFirst("sub")?.Value;
        if (sub is null)
            return new SiteContext(current, null, null, false, null, SiteAuth.Enabled(config), notice, config["Store:AppUrl"]);
        StoreUser user = http.RequestServices.GetRequiredService<StoreUsers>().FromClaims(http.User);
        string? csrf = http.RequestServices.GetRequiredService<IAntiforgery>().GetAndStoreTokens(http).RequestToken;
        return new SiteContext(current, user.Id, user.Name, user.IsAdmin, csrf, true, notice, config["Store:AppUrl"]);
    }

    private static string Canonical(HttpContext http, string path) => $"{http.Request.Scheme}://{http.Request.Host}{http.Request.PathBase}{path}";

    public static IResult Html(HttpContext http, string html, int status = 200)
    {
        HttpResponse response = http.Response;
        response.Headers["Content-Security-Policy"] = SitePages.Csp;
        response.Headers["X-Content-Type-Options"] = "nosniff";
        response.Headers["Referrer-Policy"] = "strict-origin-when-cross-origin";
        // Une personne connectee voit son nom et ses formulaires : rien en cache partage.
        response.Headers.CacheControl = status != 200 ? "no-store" : http.User.FindFirst("sub") is null ? "public, max-age=60" : "private, no-store";
        if (http.User.FindFirst("sub") is null) response.Headers.Vary = "Cookie";
        return Results.Content(html, "text/html; charset=utf-8", statusCode: status);
    }
}
