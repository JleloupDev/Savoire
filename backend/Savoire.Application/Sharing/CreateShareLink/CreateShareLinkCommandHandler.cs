// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Enums;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Sharing.CreateShareLink;

public sealed class CreateShareLinkCommandHandler(
    IVaultRepository              vaults,
    IResourcePermissionRepository permissions,
    IShareLinkRepository          shareLinks)
    : IRequestHandler<CreateShareLinkCommand, ShareLinkDto>
{
    public async Task<ShareLinkDto> Handle(CreateShareLinkCommand cmd, CancellationToken ct)
    {
        Permission   permission   = cmd.Permission.ParsePermission();
        ResourceType resourceType = cmd.ResourceType.ParseResourceType();

        if (permission == Permission.Admin)
            throw new ArgumentException("Permission invalide : 'admin' n'est pas autorise sur un lien de partage.");

        await GrantPermission.GrantPermissionCommandHandler.RequireShareRightAsync(
            cmd.CallerId, resourceType, cmd.ResourceId,
            vaults, permissions, ct);

        ShareLink link = ShareLink.Create(
            resourceType, cmd.ResourceId,
            permission, cmd.CallerId, cmd.ExpiresAt);

        await shareLinks.AddAsync(link, ct);

        return new ShareLinkDto(
            link.Id, link.Token, link.ResourceType.ToApiString(), link.ResourceId,
            link.Permission.ToApiString(), link.CreatedBy, link.CreatedAt,
            link.ExpiresAt, link.RevokedAt, link.IsValid());
    }
}
