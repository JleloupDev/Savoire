// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Microsoft.EntityFrameworkCore;
using Savoire.Domain.ReadModels;
using Savoire.Domain.Repositories;

namespace Savoire.Infrastructure.Persistence.Repositories;

public class EfFeedbackRepository(AppDbContext db) : IFeedbackRepository
{
    public async Task AddAsync(FeedbackReport r, CancellationToken ct = default)
    {
        db.FeedbackReports.Add(new FeedbackReportEntity
        {
            Id = r.Id, UserId = r.UserId, Message = r.Message, ContextJson = r.ContextJson, UserAgent = r.UserAgent,
            Screenshot = r.Screenshot, ScreenshotType = r.ScreenshotType, CreatedAt = r.CreatedAt, ArchivedAt = r.ArchivedAt,
        });
        await db.SaveChangesAsync(ct);
    }

    public async Task<IReadOnlyList<FeedbackReportSummary>> ListAsync(bool includeArchived, CancellationToken ct = default)
    {
        IQueryable<FeedbackReportEntity> rows = db.FeedbackReports.AsNoTracking();
        if (!includeArchived) rows = rows.Where(f => f.ArchivedAt == null);
        // Sans lire les captures : seulement si elles existent.
        return await rows.OrderByDescending(f => f.CreatedAt)
            .Select(f => new FeedbackReportSummary(f.Id, f.UserId, f.Message, f.ContextJson, f.UserAgent,
                f.Screenshot != null, f.CreatedAt, f.ArchivedAt))
            .ToListAsync(ct);
    }

    public async Task<(byte[] Bytes, string Type)?> GetScreenshotAsync(string id, CancellationToken ct = default)
    {
        var row = await db.FeedbackReports.AsNoTracking().Where(f => f.Id == id)
            .Select(f => new { f.Screenshot, f.ScreenshotType }).FirstOrDefaultAsync(ct);
        return row?.Screenshot is null ? null : (row.Screenshot, row.ScreenshotType ?? "image/png");
    }

    public Task<int> CountOpenForUserAsync(string userId, CancellationToken ct = default) =>
        db.FeedbackReports.AsNoTracking().CountAsync(f => f.UserId == userId && f.ArchivedAt == null, ct);

    public async Task<bool> SetArchivedAsync(string id, DateTime? at, CancellationToken ct = default) =>
        await db.FeedbackReports.Where(f => f.Id == id).ExecuteUpdateAsync(s => s.SetProperty(f => f.ArchivedAt, at), ct) > 0;

    public async Task<bool> DeleteAsync(string id, CancellationToken ct = default) =>
        await db.FeedbackReports.Where(f => f.Id == id).ExecuteDeleteAsync(ct) > 0;
}
