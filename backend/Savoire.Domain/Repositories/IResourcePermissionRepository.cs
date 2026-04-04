// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Savoire.Domain.Aggregates;
using Savoire.Domain.Enums;

namespace Savoire.Domain.Repositories;

public interface IResourcePermissionRepository
{
    Task<IReadOnlyList<ResourcePermission>> ListForResourceAsync(
        ResourceType resourceType, string resourceId, CancellationToken ct = default);

    Task<ResourcePermission?> GetAsync(
        ResourceType resourceType, string resourceId,
        SubjectType subjectType, string subjectId,
        CancellationToken ct = default);

    Task AddAsync(ResourcePermission permission, CancellationToken ct = default);

    Task DeleteAsync(string id, CancellationToken ct = default);
}
