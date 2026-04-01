// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Sharing.CreateShareLink;

public class CreateShareLinkCommandHandler(
    IVaultRepository              vaults,
    IDocumentRepository           documents,
    IResourcePermissionRepository permissions,
    IShareLinkRepository          shareLinks)
    : IRequestHandler<CreateShareLinkCommand, ShareLinkDto>
{
    public async Task<ShareLinkDto> Handle(CreateShareLinkCommand cmd, CancellationToken ct)
    {
        if (cmd.Permission is not ("read" or "write"))
            throw new ArgumentException("Permission invalide : doit être 'read' ou 'write'.");

        await GrantPermission.GrantPermissionCommandHandler.RequireShareRightAsync(
            cmd.CallerId, cmd.ResourceType, cmd.ResourceId,
            vaults, documents, permissions, ct);

        ShareLink link = ShareLink.Create(
            cmd.ResourceType, cmd.ResourceId,
            cmd.Permission, cmd.CallerId, cmd.ExpiresAt);

        await shareLinks.AddAsync(link, ct);

        return new ShareLinkDto(
            link.Id, link.Token, link.ResourceType, link.ResourceId,
            link.Permission, link.CreatedBy, link.CreatedAt,
            link.ExpiresAt, link.RevokedAt, link.IsValid());
    }
}
