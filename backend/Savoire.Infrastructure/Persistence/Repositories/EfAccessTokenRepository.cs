// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Microsoft.EntityFrameworkCore;
using Savoire.Domain.ReadModels;
using Savoire.Domain.Repositories;

namespace Savoire.Infrastructure.Persistence.Repositories;

public class EfAccessTokenRepository(AppDbContext db) : IAccessTokenRepository
{
    private static AccessToken ToDomain(AccessTokenEntity e) => new(
        e.Id, e.UserId, e.Name, e.Prefix, e.TokenHash, e.Scope,
        string.IsNullOrEmpty(e.VaultIds) ? null : e.VaultIds.Split(',', StringSplitOptions.RemoveEmptyEntries),
        e.CreatedAt, e.ExpiresAt, e.LastUsedAt, e.RevokedAt);

    public async Task AddAsync(AccessToken t, CancellationToken ct = default)
    {
        db.AccessTokens.Add(new AccessTokenEntity
        {
            Id = t.Id, UserId = t.UserId, Name = t.Name, Prefix = t.Prefix, TokenHash = t.TokenHash, Scope = t.Scope,
            VaultIds = t.VaultIds is null ? null : string.Join(',', t.VaultIds),
            CreatedAt = t.CreatedAt, ExpiresAt = t.ExpiresAt, LastUsedAt = t.LastUsedAt, RevokedAt = t.RevokedAt,
        });
        await db.SaveChangesAsync(ct);
    }

    public async Task<AccessToken?> GetByHashAsync(string tokenHash, CancellationToken ct = default)
    {
        AccessTokenEntity? e = await db.AccessTokens.AsNoTracking().FirstOrDefaultAsync(t => t.TokenHash == tokenHash, ct);
        return e is null ? null : ToDomain(e);
    }

    public async Task<IReadOnlyList<AccessToken>> ListForUserAsync(string userId, CancellationToken ct = default)
    {
        List<AccessTokenEntity> rows = await db.AccessTokens.AsNoTracking()
            .Where(t => t.UserId == userId).OrderByDescending(t => t.CreatedAt).ToListAsync(ct);
        return rows.Select(ToDomain).ToList();
    }

    public Task<int> CountActiveForUserAsync(string userId, DateTime now, CancellationToken ct = default)
        => db.AccessTokens.AsNoTracking()
            .CountAsync(t => t.UserId == userId && t.RevokedAt == null && (t.ExpiresAt == null || t.ExpiresAt > now), ct);

    public async Task<bool> RevokeAsync(string id, string userId, DateTime at, CancellationToken ct = default)
    {
        int n = await db.AccessTokens
            .Where(t => t.Id == id && t.UserId == userId && t.RevokedAt == null)
            .ExecuteUpdateAsync(s => s.SetProperty(t => t.RevokedAt, at), ct);
        return n > 0 || await db.AccessTokens.AnyAsync(t => t.Id == id && t.UserId == userId, ct);
    }

    public Task TouchAsync(string id, DateTime at, CancellationToken ct = default)
        => db.AccessTokens.Where(t => t.Id == id).ExecuteUpdateAsync(s => s.SetProperty(t => t.LastUsedAt, at), ct);
}
