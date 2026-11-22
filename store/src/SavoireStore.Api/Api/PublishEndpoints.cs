// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Editeurs et relecture.
//   POST /api/v1/publish                         { repo }  la derniere release GitHub du depot
//   GET  /api/v1/me/items                        mes elements, leurs versions et les controles
//   GET  /api/v1/admin/queue                     versions en attente de relecture
//   POST /api/v1/admin/versions/{id}/approve     { note? }
//   POST /api/v1/admin/versions/{id}/reject      { reason }
//   POST /api/v1/admin/items/{id}/remove         { reason }
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using SavoireStore.Auth;
using SavoireStore.Data;
using SavoireStore.Publishing;

namespace SavoireStore.Api;

public sealed record PublishRequest(string? Repo);
public sealed record ReviewDecision(string? Note, string? Reason);

public sealed record MyVersionDto(Guid Id, string Version, string Status, IReadOnlyList<Check> Checks, string? ReviewNote, DateTime CreatedAt, DateTime? PublishedAt);
public sealed record MyItemDto(ItemSummaryDto Item, string Status, string Repo, IReadOnlyList<MyVersionDto> Versions);

public sealed record QueueEntryDto(
    Guid VersionId, string ItemId, string Kind, string Name, string Repo, string Version, bool FirstVersion,
    IReadOnlyList<string> Permissions, IReadOnlyList<Check> Checks, string? ReleaseUrl, string Manifest, DateTime CreatedAt);

public static class PublishEndpoints
{
    private static List<Check> ChecksOf(string json) =>
        JsonSerializer.Deserialize<List<Check>>(json, PublishService.JsonOptions) ?? [];

    public static void Map(WebApplication app)
    {
        app.MapPost("/api/v1/publish", async (PublishService publish, StoreUsers users, PublishRequest req, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(req.Repo)) return Errors.BadRequest("Donnez le depot GitHub (proprietaire/nom).");
            StoreUser user = await users.CurrentAsync(ct);
            PublishResult result = await publish.SubmitAsync(user.Id, user.Name, req.Repo, ct);
            return result.Status == VersionStatus.Rejected
                ? Results.Json(new { error = new { code = "checks_failed", message = "La version ne passe pas les controles." }, result }, statusCode: 422)
                : Results.Ok(result);
        }).RequireAuthorization().RequireRateLimiting(Program.WritesPolicy);

        app.MapGet("/api/v1/me/items", async (StoreDb db, StoreUsers users, CancellationToken ct) =>
        {
            StoreUser user = await users.CurrentAsync(ct);
            List<Item> items = await db.Items.AsNoTracking().Where(i => i.PublisherId == user.Id).OrderBy(i => i.Id).ToListAsync(ct);
            List<string> ids = items.Select(i => i.Id).ToList();
            var versions = (await db.Versions.AsNoTracking().Where(v => ids.Contains(v.ItemId)).OrderByDescending(v => v.CreatedAt)
                .Select(v => new { v.Id, v.ItemId, v.Version, v.Status, v.Checks, v.ReviewNote, v.CreatedAt, v.PublishedAt }).ToListAsync(ct))
                .ToLookup(v => v.ItemId);
            return Results.Ok(items.Select(i => new MyItemDto(CatalogEndpoints.ToSummary(i), i.Status, i.Repo,
                versions[i.Id].Select(v => new MyVersionDto(v.Id, v.Version, v.Status, ChecksOf(v.Checks), v.ReviewNote, v.CreatedAt, v.PublishedAt)).ToList())));
        }).RequireAuthorization();

        RouteGroupBuilder admin = app.MapGroup("/api/v1/admin").RequireAuthorization().AddEndpointFilter(async (ctx, next) =>
        {
            StoreUser user = await ctx.HttpContext.RequestServices.GetRequiredService<StoreUsers>().CurrentAsync(ctx.HttpContext.RequestAborted);
            return user.IsAdmin ? await next(ctx) : Errors.Forbidden("Reserve aux administrateurs du store.");
        });

        admin.MapGet("/queue", async (StoreDb db, CancellationToken ct) =>
        {
            var pending = await (from v in db.Versions.AsNoTracking()
                                 join i in db.Items.AsNoTracking() on v.ItemId equals i.Id
                                 where v.Status == VersionStatus.Pending
                                 orderby v.CreatedAt
                                 select new { v, i }).ToListAsync(ct);
            return Results.Ok(pending.Select(x => new QueueEntryDto(
                x.v.Id, x.i.Id, x.i.Kind, x.i.Name, x.i.Repo, x.v.Version, x.i.LatestVersion is null,
                x.v.Permissions, ChecksOf(x.v.Checks), x.v.ReleaseUrl, x.v.Manifest, x.v.CreatedAt)));
        });

        admin.MapPost("/versions/{id:guid}/approve", async (PublishService publish, Guid id, ReviewDecision? body, CancellationToken ct) =>
        {
            await publish.ApproveAsync(id, body?.Note, ct);
            return Results.NoContent();
        });

        admin.MapPost("/versions/{id:guid}/reject", async (PublishService publish, Guid id, ReviewDecision body, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(body.Reason)) return Errors.BadRequest("Donnez la raison du refus : l'editeur la lira.");
            await publish.RejectAsync(id, body.Reason.Trim(), ct);
            return Results.NoContent();
        });

        admin.MapPost("/items/{id}/remove", async (StoreDb db, string id, ReviewDecision body, CancellationToken ct) =>
        {
            int n = await db.Items.Where(i => i.Id == id).ExecuteUpdateAsync(s => s
                .SetProperty(i => i.Status, ItemStatus.Removed).SetProperty(i => i.UpdatedAt, DateTime.UtcNow), ct);
            return n == 0 ? Errors.NotFound("Element introuvable.") : Results.NoContent();
        });
    }
}
