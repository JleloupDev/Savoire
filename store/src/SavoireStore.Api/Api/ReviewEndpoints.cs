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

/// <summary>Le resultat d'une ecriture d'avis : un statut HTTP, et le message d'un refus.</summary>
public sealed record ReviewOutcome(int Status, string? Code = null, string? Message = null, ReviewDto? Review = null)
{
    public bool Ok => Status is >= 200 and < 300;
    public IResult ToResult() => Ok ? (Review is null ? Results.NoContent() : Results.Ok(Review)) : Errors.Of(Status, Code!, Message!);
    public static ReviewOutcome Fail(int status, string code, string message) => new(status, code, message);
}

public static class ReviewEndpoints
{
    public const int MaxText = 4000;
    public const int PageSize = 20;

    private static ReviewDto ToDto(Review r, string? userId) =>
        new(r.Id, r.UserName, r.Rating, r.Text, r.MajorVersion, r.Reply, r.ReplyAt, r.CreatedAt, r.UpdatedAt, r.UserId == userId);

    public static async Task<List<ReviewDto>> ListAsync(StoreDb db, string itemId, string? userId, int page, CancellationToken ct) =>
        (await db.Reviews.AsNoTracking().Where(r => r.ItemId == itemId)
            .OrderByDescending(r => r.UpdatedAt).ThenBy(r => r.Id)
            .Skip((Math.Max(1, page) - 1) * PageSize).Take(PageSize).ToListAsync(ct))
        .Select(r => ToDto(r, userId))
        .ToList();

    /// <summary>Combien d'avis par note : [nombre de 1, ..., nombre de 5].</summary>
    public static async Task<int[]> DistributionAsync(StoreDb db, string itemId, CancellationToken ct)
    {
        var counts = await db.Reviews.AsNoTracking().Where(r => r.ItemId == itemId)
            .GroupBy(r => r.Rating).Select(g => new { g.Key, Count = g.Count() }).ToListAsync(ct);
        int[] result = new int[5];
        foreach (var c in counts) if (c.Key is >= 1 and <= 5) result[c.Key - 1] = c.Count;
        return result;
    }

    /// <summary>L'avis de cette personne sur la version majeure en cours, s'il existe.</summary>
    public static async Task<ReviewDto?> MineAsync(StoreDb db, string itemId, string userId, string? latestVersion, CancellationToken ct)
    {
        if (latestVersion is null) return null;
        int major = PackageChecks.Major(latestVersion);
        Review? r = await db.Reviews.AsNoTracking().FirstOrDefaultAsync(x => x.ItemId == itemId && x.UserId == userId && x.MajorVersion == major, ct);
        return r is null ? null : ToDto(r, userId);
    }

    /// <summary>Donner (ou remplacer) son avis sur la version majeure en cours.</summary>
    public static async Task<ReviewOutcome> UpsertAsync(StoreDb db, StoreUser user, string id, int rating, string? rawText, CancellationToken ct)
    {
        if (rating is < 1 or > 5) return ReviewOutcome.Fail(400, "invalid", "Note de 1 a 5.");
        string text = (rawText ?? "").Trim();
        if (text.Length > MaxText) return ReviewOutcome.Fail(400, "invalid", $"Avis de {MaxText} caracteres au plus.");
        Item? item = await db.Items.FirstOrDefaultAsync(i => i.Id == id && i.Status == ItemStatus.Listed, ct);
        if (item is null || item.LatestVersion is null) return ReviewOutcome.Fail(404, "not_found", "Element introuvable.");
        if (item.PublisherId == user.Id) return ReviewOutcome.Fail(403, "forbidden", "Pas d'avis sur ce que vous publiez.");
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
        item.RatingSum += rating;
        r.Rating = rating;
        r.Text = text;
        r.UserName = user.Name;
        r.UpdatedAt = now;
        await db.SaveChangesAsync(ct);
        return new ReviewOutcome(200, Review: ToDto(r, user.Id));
    }

    /// <summary>Retirer un avis : le sien, ou n'importe lequel pour un administrateur.</summary>
    public static async Task<ReviewOutcome> DeleteAsync(StoreDb db, StoreUser user, string id, Guid reviewId, CancellationToken ct)
    {
        Review? r = await db.Reviews.FirstOrDefaultAsync(x => x.Id == reviewId && x.ItemId == id, ct);
        if (r is null) return ReviewOutcome.Fail(404, "not_found", "Avis introuvable.");
        if (r.UserId != user.Id && !user.IsAdmin) return ReviewOutcome.Fail(403, "forbidden", "Cet avis n'est pas le votre.");
        Item item = await db.Items.FirstAsync(i => i.Id == id, ct);
        item.RatingSum -= r.Rating;
        item.RatingCount--;
        db.Reviews.Remove(r);
        await db.SaveChangesAsync(ct);
        return new ReviewOutcome(204);
    }

    /// <summary>La reponse de l'editeur a un avis (vide : la retirer).</summary>
    public static async Task<ReviewOutcome> ReplyAsync(StoreDb db, StoreUser user, string id, Guid reviewId, string? rawText, CancellationToken ct)
    {
        Item? item = await db.Items.AsNoTracking().FirstOrDefaultAsync(i => i.Id == id, ct);
        Review? r = await db.Reviews.FirstOrDefaultAsync(x => x.Id == reviewId && x.ItemId == id, ct);
        if (item is null || r is null) return ReviewOutcome.Fail(404, "not_found", "Avis introuvable.");
        if (item.PublisherId != user.Id) return ReviewOutcome.Fail(403, "forbidden", "Seul l'editeur repond aux avis.");
        string text = (rawText ?? "").Trim();
        if (text.Length > MaxText) return ReviewOutcome.Fail(400, "invalid", $"Reponse de {MaxText} caracteres au plus.");
        r.Reply = text.Length == 0 ? null : text;
        r.ReplyAt = text.Length == 0 ? null : DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        return new ReviewOutcome(204);
    }

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
                distribution = await DistributionAsync(db, id, ct),
                reviews = await ListAsync(db, id, me, page ?? 1, ct),
            });
        });

        api.MapPost("", async (StoreDb db, StoreUsers users, string id, ReviewRequest req, CancellationToken ct) =>
        {
            if (req.Rating is < 1 or > 5) return Errors.BadRequest("Note de 1 a 5.");
            if ((req.Text ?? "").Trim().Length > MaxText) return Errors.BadRequest($"Avis de {MaxText} caracteres au plus.");
            return (await UpsertAsync(db, await users.CurrentAsync(ct), id, req.Rating, req.Text, ct)).ToResult();
        }).RequireAuthorization().RequireRateLimiting(Program.WritesPolicy);

        api.MapDelete("/{reviewId:guid}", async (StoreDb db, StoreUsers users, string id, Guid reviewId, CancellationToken ct) =>
            (await DeleteAsync(db, await users.CurrentAsync(ct), id, reviewId, ct)).ToResult()).RequireAuthorization();

        api.MapPost("/{reviewId:guid}/reply", async (StoreDb db, StoreUsers users, string id, Guid reviewId, ReplyRequest req, CancellationToken ct) =>
            (await ReplyAsync(db, await users.CurrentAsync(ct), id, reviewId, req.Text, ct)).ToResult())
            .RequireAuthorization().RequireRateLimiting(Program.WritesPolicy);
    }
}
