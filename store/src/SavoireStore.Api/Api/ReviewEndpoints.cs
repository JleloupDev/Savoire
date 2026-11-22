// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les avis : tout compte Savoire peut en laisser un, une note de 1 a 5 et un
// texte, un par element et par version majeure (le renvoyer le remplace).
// Pas d'avis sur ce qu'on publie soi-meme. L'editeur peut repondre.
using Microsoft.EntityFrameworkCore;
using SavoireStore.Auth;
using SavoireStore.Data;
using SavoireStore.Publishing;

namespace SavoireStore.Api;

public sealed record ReviewRequest(int Rating, string? Text);
public sealed record ReplyRequest(string? Text);

public sealed record ReviewDto(
    Guid Id, string UserName, int Rating, string Text, int MajorVersion, string? Reply, DateTime? ReplyAt,
    DateTime CreatedAt, DateTime UpdatedAt, bool Mine);

public static class ReviewEndpoints
{
    public const int MaxText = 4000;

    public static async Task<List<ReviewDto>> ListAsync(StoreDb db, string itemId, string? userId, int page, CancellationToken ct) =>
        (await db.Reviews.AsNoTracking().Where(r => r.ItemId == itemId)
            .OrderByDescending(r => r.UpdatedAt).ThenBy(r => r.Id)
            .Skip((Math.Max(1, page) - 1) * 20).Take(20).ToListAsync(ct))
        .Select(r => new ReviewDto(r.Id, r.UserName, r.Rating, r.Text, r.MajorVersion, r.Reply, r.ReplyAt, r.CreatedAt, r.UpdatedAt, r.UserId == userId))
        .ToList();

    public static void Map(WebApplication app)
    {
        RouteGroupBuilder api = app.MapGroup("/api/v1/items/{id}/reviews");

        api.MapGet("", async (StoreDb db, HttpContext ctx, string id, int? page, CancellationToken ct) =>
        {
            Item? item = await db.Items.AsNoTracking().FirstOrDefaultAsync(i => i.Id == id && i.Status == ItemStatus.Listed, ct);
            if (item is null) return Errors.NotFound("Element introuvable.");
            string? me = ctx.User.FindFirst("sub")?.Value;
            return Results.Ok(new
            {
                rating = item.RatingCount == 0 ? (double?)null : Math.Round((double)item.RatingSum / item.RatingCount, 1),
                count = item.RatingCount,
                reviews = await ListAsync(db, id, me, page ?? 1, ct),
            });
        });

        api.MapPost("", async (StoreDb db, StoreUsers users, string id, ReviewRequest req, CancellationToken ct) =>
        {
            if (req.Rating is < 1 or > 5) return Errors.BadRequest("Note de 1 a 5.");
            string text = (req.Text ?? "").Trim();
            if (text.Length > MaxText) return Errors.BadRequest($"Avis de {MaxText} caracteres au plus.");
            StoreUser user = await users.CurrentAsync(ct);
            Item? item = await db.Items.FirstOrDefaultAsync(i => i.Id == id && i.Status == ItemStatus.Listed, ct);
            if (item is null || item.LatestVersion is null) return Errors.NotFound("Element introuvable.");
            if (item.PublisherId == user.Id) return Errors.Forbidden("Pas d'avis sur ce que vous publiez.");
            int major = PackageChecks.Major(item.LatestVersion);
            DateTime now = DateTime.UtcNow;
            Review? r = await db.Reviews.FirstOrDefaultAsync(x => x.ItemId == id && x.UserId == user.Id && x.MajorVersion == major, ct);
            if (r is null)
            {
                r = new Review { Id = Guid.NewGuid(), ItemId = id, UserId = user.Id, MajorVersion = major, CreatedAt = now };
                db.Reviews.Add(r);
                item.RatingCount++;
            }
            else item.RatingSum -= r.Rating;
            item.RatingSum += req.Rating;
            r.Rating = req.Rating;
            r.Text = text;
            r.UserName = user.Name;
            r.UpdatedAt = now;
            await db.SaveChangesAsync(ct);
            return Results.Ok(new ReviewDto(r.Id, r.UserName, r.Rating, r.Text, r.MajorVersion, r.Reply, r.ReplyAt, r.CreatedAt, r.UpdatedAt, true));
        }).RequireAuthorization().RequireRateLimiting(Program.WritesPolicy);

        api.MapDelete("/{reviewId:guid}", async (StoreDb db, StoreUsers users, string id, Guid reviewId, CancellationToken ct) =>
        {
            StoreUser user = await users.CurrentAsync(ct);
            Review? r = await db.Reviews.FirstOrDefaultAsync(x => x.Id == reviewId && x.ItemId == id, ct);
            if (r is null) return Errors.NotFound("Avis introuvable.");
            if (r.UserId != user.Id && !user.IsAdmin) return Errors.Forbidden("Cet avis n'est pas le votre.");
            Item item = await db.Items.FirstAsync(i => i.Id == id, ct);
            item.RatingSum -= r.Rating;
            item.RatingCount--;
            db.Reviews.Remove(r);
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        }).RequireAuthorization();

        api.MapPost("/{reviewId:guid}/reply", async (StoreDb db, StoreUsers users, string id, Guid reviewId, ReplyRequest req, CancellationToken ct) =>
        {
            StoreUser user = await users.CurrentAsync(ct);
            Item? item = await db.Items.AsNoTracking().FirstOrDefaultAsync(i => i.Id == id, ct);
            Review? r = await db.Reviews.FirstOrDefaultAsync(x => x.Id == reviewId && x.ItemId == id, ct);
            if (item is null || r is null) return Errors.NotFound("Avis introuvable.");
            if (item.PublisherId != user.Id) return Errors.Forbidden("Seul l'editeur repond aux avis.");
            string text = (req.Text ?? "").Trim();
            if (text.Length > MaxText) return Errors.BadRequest($"Reponse de {MaxText} caracteres au plus.");
            r.Reply = text.Length == 0 ? null : text;
            r.ReplyAt = text.Length == 0 ? null : DateTime.UtcNow;
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        }).RequireAuthorization().RequireRateLimiting(Program.WritesPolicy);
    }
}
