// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le catalogue, sans compte : chercher, voir un element, telecharger un
// paquet signe, connaitre la cle publique du store.
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using SavoireStore.Data;
using SavoireStore.Signing;

namespace SavoireStore.Api;

public sealed record PriceDto(int Cents, string Currency);

public sealed record ItemSummaryDto(
    string Id, string Kind, string Name, string Summary, string Author, string? LatestVersion,
    IReadOnlyList<string> Categories, double? Rating, int RatingCount, long Downloads, PriceDto? Price, DateTime UpdatedAt,
    Guid? IconId = null);

public sealed record VersionDto(string Version, string? MinAppVersion, IReadOnlyList<string> Permissions, DateTime? PublishedAt, string Sha256);

/// <summary>Une capture d'ecran : l'image est servie par GET /media/{id}.</summary>
public sealed record ScreenshotDto(Guid Id, string? Caption, int Width, int Height);

public sealed record ItemDetailDto(
    ItemSummaryDto Item, string Description, string Repo, string? License, string? Homepage,
    IReadOnlyList<string> Permissions, IReadOnlyList<VersionDto> Versions,
    IReadOnlyList<string>? Capabilities = null, string? Runtime = null, Publishing.AgentPreset.Summary? Agent = null,
    IReadOnlyList<ScreenshotDto>? Screenshots = null);

public sealed record ItemPageDto(IReadOnlyList<ItemSummaryDto> Items, int Total, int Page, int PageSize);

public sealed record CategoryCountDto(string Slug, string Name, string Description, int Count);

/// <summary>Combien d'elements par sorte, categorie et prix, pour les filtres du catalogue.</summary>
public sealed record FacetsDto(IReadOnlyDictionary<string, int> Kinds, IReadOnlyList<CategoryCountDto> Categories, int Free, int Paid);

/// <summary>Une recherche dans le catalogue. Price : « free » ou « paid ». MinRating : note moyenne minimale (1 a 5).</summary>
public sealed record CatalogQuery(
    string? Q = null, string? Kind = null, string? Category = null, string? Price = null, int? MinRating = null,
    string? Sort = null, int Page = 1, int PageSize = 20);

public static class CatalogEndpoints
{
    public const int MaxPageSize = 50;

    public static readonly string[] Sorts = ["popular", "recent", "rating", "name"];

    public static ItemSummaryDto ToSummary(Item i) => new(
        i.Id, i.Kind, i.Name, i.Summary, i.Author, i.LatestVersion, i.Categories,
        i.RatingCount == 0 ? null : Math.Round((double)i.RatingSum / i.RatingCount, 1), i.RatingCount, i.Downloads,
        i.PriceCents is int c && i.Currency is { } cur ? new PriceDto(c, cur) : null, i.UpdatedAt, i.IconId);

    private static IQueryable<Item> Listed(StoreDb db) => db.Items.AsNoTracking().Where(i => i.Status == ItemStatus.Listed);

    /// <summary>Texte, prix et note : les filtres qui ne sont pas des facettes.</summary>
    private static IQueryable<Item> Common(IQueryable<Item> items, CatalogQuery query)
    {
        if (!string.IsNullOrWhiteSpace(query.Q))
        {
            string q = query.Q.Trim();
            if (q.Length > 100) q = q[..100];
            string like = "%" + q.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_") + "%";
            string slug = Categories.Slug(q);
            items = items.Where(i => EF.Functions.ILike(i.Name, like) || EF.Functions.ILike(i.Summary, like)
                || EF.Functions.ILike(i.Description, like) || EF.Functions.ILike(i.Id, like) || EF.Functions.ILike(i.Author, like)
                || i.Categories.Contains(slug));
        }
        if (query.Price == "free") items = items.Where(i => i.PriceCents == null);
        else if (query.Price == "paid") items = items.Where(i => i.PriceCents != null);
        if (query.MinRating is int r and >= 1 and <= 5) items = items.Where(i => i.RatingCount > 0 && i.RatingSum >= r * i.RatingCount);
        return items;
    }

    private static IQueryable<Item> ByKind(IQueryable<Item> items, string? kind) =>
        !string.IsNullOrWhiteSpace(kind) && ItemKinds.All.Contains(kind) ? items.Where(i => i.Kind == kind) : items;

    private static IQueryable<Item> ByCategory(IQueryable<Item> items, string? category)
    {
        if (string.IsNullOrWhiteSpace(category)) return items;
        string c = Categories.Slug(category);
        return items.Where(i => i.Categories.Contains(c));
    }

    public static Task<ItemPageDto> SearchAsync(StoreDb db, string? q, string? kind, string? category, string? sort, int page, int pageSize, CancellationToken ct)
        => SearchAsync(db, new CatalogQuery(q, kind, category, Sort: sort, Page: page, PageSize: pageSize), ct);

    public static async Task<ItemPageDto> SearchAsync(StoreDb db, CatalogQuery query, CancellationToken ct)
    {
        int page = Math.Max(1, query.Page);
        int pageSize = Math.Clamp(query.PageSize, 1, MaxPageSize);
        IQueryable<Item> items = ByCategory(ByKind(Common(Listed(db), query), query.Kind), query.Category);
        items = query.Sort switch
        {
            "recent" => items.OrderByDescending(i => i.UpdatedAt).ThenBy(i => i.Id),
            "rating" => items.OrderByDescending(i => i.RatingCount == 0 ? 0 : (double)i.RatingSum / i.RatingCount)
                .ThenByDescending(i => i.RatingCount).ThenBy(i => i.Id),
            "name" => items.OrderBy(i => i.Name).ThenBy(i => i.Id),
            _ => items.OrderByDescending(i => i.Downloads).ThenBy(i => i.Id),
        };
        int total = await items.CountAsync(ct);
        List<Item> rows = await items.Skip((page - 1) * pageSize).Take(pageSize).ToListAsync(ct);
        return new ItemPageDto(rows.Select(ToSummary).ToList(), total, page, pageSize);
    }

    /// <summary>
    /// Les comptes des filtres. Chaque facette compte sans son propre filtre
    /// (les sortes avec la categorie choisie, et inversement), pour montrer ce
    /// qu'on trouverait en changeant de choix.
    /// </summary>
    public static async Task<FacetsDto> FacetsAsync(StoreDb db, CatalogQuery query, CancellationToken ct)
    {
        IQueryable<Item> common = Common(Listed(db), query);
        Dictionary<string, int> kinds = await ByCategory(common, query.Category)
            .GroupBy(i => i.Kind).Select(g => new { g.Key, Count = g.Count() }).ToDictionaryAsync(g => g.Key, g => g.Count, ct);
        List<List<string>> lists = await ByKind(common, query.Kind).Select(i => i.Categories).ToListAsync(ct);
        List<CategoryCountDto> categories = CountCategories(lists);
        var prices = await ByCategory(ByKind(Listed(db), query.Kind), query.Category)
            .GroupBy(i => i.PriceCents == null).Select(g => new { Free = g.Key, Count = g.Count() }).ToListAsync(ct);
        return new FacetsDto(kinds, categories, prices.FirstOrDefault(p => p.Free)?.Count ?? 0, prices.FirstOrDefault(p => !p.Free)?.Count ?? 0);
    }

    /// <summary>Toutes les categories du catalogue, les plus fournies d'abord.</summary>
    public static async Task<List<CategoryCountDto>> CategoriesAsync(StoreDb db, CancellationToken ct) =>
        CountCategories(await Listed(db).Select(i => i.Categories).ToListAsync(ct));

    private static List<CategoryCountDto> CountCategories(IEnumerable<List<string>> lists) =>
        lists.SelectMany(l => l).GroupBy(c => c)
            .Select(g => { Category c = Categories.Of(g.Key); return new CategoryCountDto(c.Slug, c.Name, c.Description, g.Count()); })
            .OrderByDescending(c => c.Count).ThenBy(c => c.Name, StringComparer.Create(System.Globalization.CultureInfo.InvariantCulture, true))
            .ToList();

    /// <summary>D'autres elements proches : meme categorie d'abord, sinon meme sorte.</summary>
    public static async Task<List<ItemSummaryDto>> RelatedAsync(StoreDb db, ItemSummaryDto item, int count, CancellationToken ct)
    {
        List<string> cats = item.Categories.ToList();
        List<Item> rows = await Listed(db).Where(i => i.Id != item.Id && (i.Categories.Any(c => cats.Contains(c)) || i.Kind == item.Kind))
            .OrderByDescending(i => i.Categories.Any(c => cats.Contains(c))).ThenByDescending(i => i.Downloads).ThenBy(i => i.Id)
            .Take(count).ToListAsync(ct);
        return rows.Select(ToSummary).ToList();
    }

    public static async Task<ItemDetailDto?> DetailAsync(StoreDb db, string id, CancellationToken ct)
    {
        Item? i = await db.Items.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id && x.Status == ItemStatus.Listed, ct);
        if (i is null) return null;
        List<ItemVersion> versions = await db.Versions.AsNoTracking()
            .Where(v => v.ItemId == id && v.Status == VersionStatus.Published).ToListAsync(ct);
        versions.Sort((a, b) => Publishing.PackageChecks.CompareVersions(b.Version, a.Version));
        List<VersionDto> dtos = versions.Select(v => new VersionDto(v.Version, v.MinAppVersion, v.Permissions, v.PublishedAt, v.Sha256)).ToList();
        ItemVersion? latest = versions.FirstOrDefault(v => v.Version == i.LatestVersion);
        // Capacites annoncees et facon de tourner : lues dans le manifeste de la derniere version.
        JsonObject? manifest = null;
        try { manifest = latest is null ? null : JsonNode.Parse(latest.Manifest) as JsonObject; } catch (JsonException) { }
        List<string> capabilities = manifest is null ? [] : Publishing.PackageChecks.StrList(manifest, "capabilities")
            .Where(Publishing.PackageChecks.Capabilities.ContainsKey).ToList();
        string? runtime = i.Kind == ItemKinds.Plugin ? (manifest is null ? null : Publishing.PackageChecks.Str(manifest, "runtime") ?? "page") : null;
        // Modele d'agent : agent.json du paquet signe, pour afficher ses droits en clair.
        Publishing.AgentPreset.Summary? agent = null;
        if (i.Kind == ItemKinds.Agent && latest is not null)
        {
            try
            {
                if (JsonNode.Parse(latest.Package) is JsonObject pkg && pkg["files"] is JsonObject files
                    && files["agent.json"] is JsonValue aj && aj.TryGetValue(out string? text) && text is not null)
                    agent = Publishing.AgentPreset.Describe(text);
            }
            catch (JsonException) { }
        }
        List<ScreenshotDto> screenshots = latest is null ? [] : await db.Media.AsNoTracking()
            .Where(m => m.VersionId == latest.Id && m.Role == MediaRoles.Screenshot).OrderBy(m => m.Position)
            .Select(m => new ScreenshotDto(m.Id, m.Caption, m.Width, m.Height)).ToListAsync(ct);
        return new ItemDetailDto(ToSummary(i), i.Description, i.Repo, i.License, i.Homepage,
            latest?.Permissions ?? [], dtos, capabilities, runtime, agent, screenshots);
    }

    public static void Map(WebApplication app)
    {
        RouteGroupBuilder api = app.MapGroup("/api/v1");

        api.MapGet("/items", (StoreDb db, string? q, string? kind, string? category, string? price, int? minRating, string? sort, int? page, int? pageSize, CancellationToken ct)
            => SearchAsync(db, new CatalogQuery(q, kind, category, price, minRating, sort, page ?? 1, pageSize ?? 20), ct));

        api.MapGet("/facets", (StoreDb db, string? q, string? kind, string? category, string? price, int? minRating, CancellationToken ct)
            => FacetsAsync(db, new CatalogQuery(q, kind, category, price, minRating), ct));

        api.MapGet("/categories", (StoreDb db, CancellationToken ct) => CategoriesAsync(db, ct));

        api.MapGet("/items/{id}", async (StoreDb db, string id, CancellationToken ct)
            => await DetailAsync(db, id, ct) is { } d ? Results.Ok(d) : Errors.NotFound("Element introuvable."));

        api.MapGet("/items/{id}/download", async (StoreDb db, PackageSigner signer, HttpResponse response, string id, string? version, CancellationToken ct) =>
        {
            Item? item = await db.Items.FirstOrDefaultAsync(x => x.Id == id && x.Status == ItemStatus.Listed, ct);
            string? wanted = version ?? item?.LatestVersion;
            ItemVersion? v = item is null || wanted is null ? null : await db.Versions.AsNoTracking()
                .FirstOrDefaultAsync(x => x.ItemId == id && x.Version == wanted && x.Status == VersionStatus.Published, ct);
            if (v is null || v.Signature is null) return Errors.NotFound("Version introuvable.");
            await db.Items.Where(x => x.Id == id).ExecuteUpdateAsync(s => s.SetProperty(x => x.Downloads, x => x.Downloads + 1), ct);
            response.Headers["X-Savoire-Signature"] = v.Signature;
            response.Headers["X-Savoire-Sha256"] = v.Sha256;
            response.Headers["X-Savoire-Key-Id"] = signer.KeyId;
            response.Headers.ContentDisposition = $"attachment; filename=\"{id}-{v.Version}.json\"";
            return Results.Bytes(v.Package, "application/json");
        });

        // Les images (icones, captures) : jamais modifiees une fois envoyees.
        app.MapGet("/media/{id:guid}", async (StoreDb db, HttpResponse response, Guid id, CancellationToken ct) =>
        {
            var m = await db.Media.AsNoTracking().Where(x => x.Id == id)
                .Join(db.Items.Where(i => i.Status == ItemStatus.Listed), x => x.ItemId, i => i.Id, (x, i) => new { x.ContentType, x.Bytes })
                .FirstOrDefaultAsync(ct);
            if (m is null) return Errors.NotFound("Image introuvable.");
            response.Headers.CacheControl = "public, max-age=31536000, immutable";
            response.Headers["X-Content-Type-Options"] = "nosniff";
            response.Headers["Content-Security-Policy"] = "default-src 'none'; sandbox";
            response.Headers["Cross-Origin-Resource-Policy"] = "cross-origin";
            return Results.Bytes(m.Bytes, m.ContentType);
        });

        api.MapGet("/signing-key", (PackageSigner signer) =>
            Results.Ok(new { keyId = signer.KeyId, algorithm = "ECDSA-P256-SHA256", format = "ieee-p1363", spki = signer.PublicKeySpki }));
    }
}
