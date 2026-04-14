// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Notifications;
using Savoire.Domain.Enums;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Repositories;
using Savoire.Domain.Services;

namespace Savoire.Application.Sharing.RevokePermission;

public class RevokePermissionCommandHandler(
    IVaultRepository              vaults,
    IDocumentRepository           documents,
    IResourcePermissionRepository permissions,
    IPublisher                    publisher)
    : IRequestHandler<RevokePermissionCommand>
{
    public async Task Handle(RevokePermissionCommand cmd, CancellationToken ct)
    {
        ResourceType resourceType = cmd.ResourceType.ParseResourceType();

        await GrantPermission.GrantPermissionCommandHandler.RequireShareRightAsync(
            cmd.CallerId, resourceType, cmd.ResourceId,
            vaults, documents, permissions, ct);

        var perm = await permissions.GetAsync(
            resourceType, cmd.ResourceId, SubjectType.User, cmd.TargetUserId, ct);

        if (perm is null) throw new AccessDeniedException(
            $"Aucune permission trouvée pour {cmd.TargetUserId} sur {cmd.ResourceType}/{cmd.ResourceId}.");

        await permissions.DeleteAsync(perm.Id, ct);

        if (resourceType == ResourceType.Vault)
            await vaults.RemoveMemberAsync(cmd.ResourceId, cmd.TargetUserId, ct);

        if (resourceType == ResourceType.Document)
            await publisher.Publish(new AccessRevokedNotification(cmd.ResourceId, cmd.TargetUserId), ct);
    }
}
