// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Savoire.Domain.Aggregates;

namespace Savoire.Domain.Repositories;

public interface IResourcePermissionRepository
{
    Task<IReadOnlyList<ResourcePermission>> ListForResourceAsync(
        string resourceType, string resourceId, CancellationToken ct = default);

    Task<ResourcePermission?> GetAsync(
        string resourceType, string resourceId,
        string subjectType, string subjectId,
        CancellationToken ct = default);

    Task AddAsync(ResourcePermission permission, CancellationToken ct = default);

    Task DeleteAsync(string id, CancellationToken ct = default);
}
