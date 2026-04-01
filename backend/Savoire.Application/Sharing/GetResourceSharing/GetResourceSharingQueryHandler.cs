// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Repositories;
using Savoire.Domain.Services;

namespace Savoire.Application.Sharing.GetResourceSharing;

public class GetResourceSharingQueryHandler(
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
        await GrantPermission.GrantPermissionCommandHandler.RequireShareRightAsync(
            q.CallerId, q.ResourceType, q.ResourceId,
            vaults, documents, permissions, ct);

        IReadOnlyList<ResourcePermission> perms =
            await permissions.ListForResourceAsync(q.ResourceType, q.ResourceId, ct);

        IReadOnlyList<ShareLink> links =
            await shareLinks.ListForResourceAsync(q.ResourceType, q.ResourceId, ct);

        // Enrich permissions with display names
        var permDtos = new List<ResourcePermissionDto>();
        foreach (ResourcePermission p in perms)
        {
            string? displayName = p.SubjectType == "user"
                ? (await users.GetByIdAsync(p.SubjectId, ct))?.DisplayName
                : null;
            permDtos.Add(GrantPermission.GrantPermissionCommandHandler.ToDto(p, displayName));
        }

        var linkDtos = links.Select(l => new ShareLinkDto(
            l.Id, l.Token, l.ResourceType, l.ResourceId,
            l.Permission, l.CreatedBy, l.CreatedAt, l.ExpiresAt, l.RevokedAt,
            l.IsValid())).ToList();

        return new ResourceSharingDto(q.ResourceType, q.ResourceId, permDtos, linkDtos);
    }
}
