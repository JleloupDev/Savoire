// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Sharing.RevokeShareLink;

public sealed class RevokeShareLinkCommandHandler(
    IVaultRepository              vaults,
    IDocumentRepository           documents,
    IResourcePermissionRepository permissions,
    IShareLinkRepository          shareLinks)
    : IRequestHandler<RevokeShareLinkCommand>
{
    public async Task Handle(RevokeShareLinkCommand cmd, CancellationToken ct)
    {
        ShareLink? link = await shareLinks.GetByIdAsync(cmd.LinkId, ct);
        if (link is null) return;   // idempotent

        await GrantPermission.GrantPermissionCommandHandler.RequireShareRightAsync(
            cmd.CallerId, link.ResourceType, link.ResourceId,
            vaults, documents, permissions, ct);

        link.Revoke();
        await shareLinks.UpdateAsync(link, ct);
    }
}
