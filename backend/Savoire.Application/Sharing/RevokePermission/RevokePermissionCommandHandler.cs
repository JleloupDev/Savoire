// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Repositories;
using Savoire.Domain.Services;

namespace Savoire.Application.Sharing.RevokePermission;

public class RevokePermissionCommandHandler(
    IVaultRepository              vaults,
    IDocumentRepository           documents,
    IResourcePermissionRepository permissions)
    : IRequestHandler<RevokePermissionCommand>
{
    public async Task Handle(RevokePermissionCommand cmd, CancellationToken ct)
    {
        await GrantPermission.GrantPermissionCommandHandler.RequireShareRightAsync(
            cmd.CallerId, cmd.ResourceType, cmd.ResourceId,
            vaults, documents, permissions, ct);

        var perm = await permissions.GetAsync(
            cmd.ResourceType, cmd.ResourceId, "user", cmd.TargetUserId, ct);

        if (perm is null) throw new AccessDeniedException(
            $"Aucune permission trouvée pour {cmd.TargetUserId} sur {cmd.ResourceType}/{cmd.ResourceId}.");

        await permissions.DeleteAsync(perm.Id, ct);
    }
}
