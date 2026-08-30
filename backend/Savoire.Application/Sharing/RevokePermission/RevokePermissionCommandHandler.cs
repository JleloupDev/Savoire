// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Notifications;
using Savoire.Domain.Enums;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Repositories;
using Savoire.Domain.Services;

namespace Savoire.Application.Sharing.RevokePermission;

public sealed class RevokePermissionCommandHandler(
    IVaultRepository              vaults,
    IResourcePermissionRepository permissions,
    IVaultMemberIdentityRepository identities,
    IPublisher                    publisher)
    : IRequestHandler<RevokePermissionCommand>
{
    public async Task Handle(RevokePermissionCommand cmd, CancellationToken ct)
    {
        ResourceType resourceType = cmd.ResourceType.ParseResourceType();

        await GrantPermission.GrantPermissionCommandHandler.RequireShareRightAsync(
            cmd.CallerId, resourceType, cmd.ResourceId,
            vaults, permissions, ct);

        var perm = await permissions.GetAsync(
            resourceType, cmd.ResourceId, SubjectType.User, cmd.TargetUserId, ct);

        if (perm is null) throw new AccessDeniedException(
            $"Aucune permission trouvee pour {cmd.TargetUserId} sur {cmd.ResourceType}/{cmd.ResourceId}.");

        await permissions.DeleteAsync(perm.Id, ct);

        if (resourceType == ResourceType.Vault)
        {
            await vaults.RemoveMemberAsync(cmd.ResourceId, cmd.TargetUserId, ct);
            await identities.RemoveForUserAsync(cmd.ResourceId, cmd.TargetUserId, ct);
            await publisher.Publish(new VaultMembershipChangedNotification(cmd.ResourceId), ct);
        }

        if (resourceType == ResourceType.Document)
            await publisher.Publish(new AccessRevokedNotification(cmd.ResourceId, cmd.TargetUserId), ct);
    }
}
