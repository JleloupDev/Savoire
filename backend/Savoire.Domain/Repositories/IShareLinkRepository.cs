// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Savoire.Domain.Aggregates;

namespace Savoire.Domain.Repositories;

public interface IShareLinkRepository
{
    Task<ShareLink?> GetByTokenAsync(string token, CancellationToken ct = default);

    Task<ShareLink?> GetByIdAsync(string id, CancellationToken ct = default);

    Task<IReadOnlyList<ShareLink>> ListForResourceAsync(
        string resourceType, string resourceId, CancellationToken ct = default);

    Task AddAsync(ShareLink link, CancellationToken ct = default);

    Task UpdateAsync(ShareLink link, CancellationToken ct = default);
}
