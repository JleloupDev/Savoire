// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Enums;
using Savoire.Domain.Repositories;
using Savoire.Domain.Services;

namespace Savoire.Application.Sharing.GetResourceSharing;

public sealed class GetResourceSharingQueryHandler(
    IVaultRepository              vaults,
    IDocumentRepository           documents,
    IResourcePermissionRepository permissions,
    IShareLinkRepository          shareLinks,
    IUserLookupService            users)
    : IRequestHandler<GetResourceSharingQuery, ResourceSharingDto>
{
    public async Task<ResourceSharingDto> Handle(
        GetResourceSharingQuery q, CancellationToken ct)
    {
        ResourceType resourceType = q.ResourceType.ParseResourceType();

        await GrantPermission.GrantPermissionCommandHandler.RequireShareRightAsync(
            q.CallerId, resourceType, q.ResourceId,
            vaults, documents, permissions, ct);

        IReadOnlyList<ResourcePermission> perms =
            await permissions.ListForResourceAsync(resourceType, q.ResourceId, ct);

        IReadOnlyList<ShareLink> links =
            await shareLinks.ListForResourceAsync(resourceType, q.ResourceId, ct);

        // Enrich permissions with display names
        var permDtos = new List<ResourcePermissionDto>();
        foreach (ResourcePermission p in perms)
        {
            string? displayName = p.SubjectType == SubjectType.User
                ? (await users.GetByIdAsync(p.SubjectId, ct))?.DisplayName
                : null;
            permDtos.Add(GrantPermission.GrantPermissionCommandHandler.ToDto(p, displayName));
        }

        var linkDtos = links.Select(l => new ShareLinkDto(
            l.Id, l.Token, l.ResourceType.ToApiString(), l.ResourceId,
            l.Permission.ToApiString(), l.CreatedBy, l.CreatedAt, l.ExpiresAt, l.RevokedAt,
            l.IsValid())).ToList();

        return new ResourceSharingDto(q.ResourceType, q.ResourceId, permDtos, linkDtos);
    }
}
