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
    IReadOnlyList<string> Categories, double? Rating, int RatingCount, long Downloads, PriceDto? Price, DateTime UpdatedAt);

public sealed record VersionDto(string Version, string? MinAppVersion, IReadOnlyList<string> Permissions, DateTime? PublishedAt, string Sha256);

public sealed record ItemDetailDto(
    ItemSummaryDto Item, string Description, string Repo, string? License, string? Homepage,
    IReadOnlyList<string> Permissions, IReadOnlyList<VersionDto> Versions,
    IReadOnlyList<string>? Capabilities = null, string? Runtime = null, Publishing.AgentPreset.Summary? Agent = null);

public sealed record ItemPageDto(IReadOnlyList<ItemSummaryDto> Items, int Total, int Page, int PageSize);

public static class CatalogEndpoints
{
    public const int MaxPageSize = 50;

    public static ItemSummaryDto ToSummary(Item i) => new(
        i.Id, i.Kind, i.Name, i.Summary, i.Author, i.LatestVersion, i.Categories,
        i.RatingCount == 0 ? null : Math.Round((double)i.RatingSum / i.RatingCount, 1), i.RatingCount, i.Downloads,
        i.PriceCents is int c && i.Currency is { } cur ? new PriceDto(c, cur) : null, i.UpdatedAt);

    public static async Task<ItemPageDto> SearchAsync(StoreDb db, string? q, string? kind, string? category, string? sort, int page, int pageSize, CancellationToken ct)
    {
        page = Math.Max(1, page);
        pageSize = Math.Clamp(pageSize, 1, MaxPageSize);
        IQueryable<Item> items = db.Items.AsNoTracking().Where(i => i.Status == ItemStatus.Listed);
        if (!string.IsNullOrWhiteSpace(kind) && ItemKinds.All.Contains(kind)) items = items.Where(i => i.Kind == kind);
        if (!string.IsNullOrWhiteSpace(category)) { string c = category.ToLowerInvariant(); items = items.Where(i => i.Categories.Contains(c)); }
        if (!string.IsNullOrWhiteSpace(q))
        {
            string like = "%" + q.Trim().Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_") + "%";
            items = items.Where(i => EF.Functions.ILike(i.Name, like) || EF.Functions.ILike(i.Summary, like)
                || EF.Functions.ILike(i.Id, like) || EF.Functions.ILike(i.Author, like));
        }
        items = sort switch
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
        return new ItemDetailDto(ToSummary(i), i.Description, i.Repo, i.License, i.Homepage,
            latest?.Permissions ?? [], dtos, capabilities, runtime, agent);
    }

    public static void Map(WebApplication app)
    {
        RouteGroupBuilder api = app.MapGroup("/api/v1");

        api.MapGet("/items", (StoreDb db, string? q, string? kind, string? category, string? sort, int? page, int? pageSize, CancellationToken ct)
            => SearchAsync(db, q, kind, category, sort, page ?? 1, pageSize ?? 20, ct));

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

        api.MapGet("/signing-key", (PackageSigner signer) =>
            Results.Ok(new { keyId = signer.KeyId, algorithm = "ECDSA-P256-SHA256", format = "ieee-p1363", spki = signer.PublicKeySpki }));
    }
}
