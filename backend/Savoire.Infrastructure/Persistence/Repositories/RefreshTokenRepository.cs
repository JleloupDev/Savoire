// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Microsoft.EntityFrameworkCore;
using Savoire.Domain.Repositories;
using Savoire.Domain.Entities;

namespace Savoire.Infrastructure.Persistence.Repositories;

public class RefreshTokenRepository(AppDbContext db) : IRefreshTokenRepository
{
    public Task<RefreshToken?> GetByHashedTokenAsync(
        string hashedToken, CancellationToken ct = default)
        => db.RefreshTokens.FirstOrDefaultAsync(t => t.Token == hashedToken, ct);

    public async Task<IReadOnlyList<RefreshToken>> GetActiveByUserIdAsync(
        string userId, CancellationToken ct = default)
        => await db.RefreshTokens
            .Where(t => t.UserId == userId && t.RevokedAt == null)
            .ToListAsync(ct);

    public async Task AddAsync(RefreshToken token, CancellationToken ct = default)
        => await db.RefreshTokens.AddAsync(token, ct);

    public Task SaveChangesAsync(CancellationToken ct = default)
        => db.SaveChangesAsync(ct);
}
