// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Application.Notifications;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Enums;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Repositories;
using Savoire.Domain.Services;

namespace Savoire.Application.Sharing.GrantPermission;

public sealed class GrantPermissionCommandHandler(
    IVaultRepository              vaults,
    IResourcePermissionRepository permissions,
    IUserLookupService            users,
    IPublisher                    publisher,
    IVaultDocumentRepository      vaultDocuments)
    : IRequestHandler<GrantPermissionCommand, ResourcePermissionDto>
{
    public async Task<ResourcePermissionDto> Handle(
        GrantPermissionCommand cmd, CancellationToken ct)
    {
        ResourceType resourceType = cmd.ResourceType.ParseResourceType();
        Permission   permission   = cmd.Permission.ParsePermission();

        await RequireShareRightAsync(cmd.CallerId, resourceType, cmd.ResourceId, vaults, permissions, vaultDocuments, ct);

        ResourcePermission? existing = await permissions.GetAsync(
            resourceType, cmd.ResourceId, SubjectType.User, cmd.TargetUserId, ct);
        if (existing is not null)
            await permissions.DeleteAsync(existing.Id, ct);

        ResourcePermission perm = ResourcePermission.Create(
            resourceType, cmd.ResourceId,
            SubjectType.User, cmd.TargetUserId,
            permission, cmd.CallerId, cmd.ExpiresAt);
        await permissions.AddAsync(perm, ct);

        if (resourceType == ResourceType.Vault)
        {
            VaultRole role = permission == Permission.Read ? VaultRole.Viewer : VaultRole.Editor;
            await vaults.AddMemberAsync(
                new VaultMember(cmd.ResourceId, cmd.TargetUserId, role, DateTime.UtcNow), ct);
            await publisher.Publish(new VaultMembershipChangedNotification(cmd.ResourceId), ct);
        }

        string? displayName = (await users.GetByIdAsync(cmd.TargetUserId, ct))?.DisplayName;
        return ToDto(perm, displayName);
    }

    internal static async Task RequireShareRightAsync(
        string callerId, ResourceType resourceType, string resourceId,
        IVaultRepository vaults, IResourcePermissionRepository permissions,
        IVaultDocumentRepository vaultDocuments, CancellationToken ct)
    {
        // Un document se partage selon les droits sur SON vault, retrouve par le
        // registre « document -> vault ». Avant ce registre, la verification
        // etait sautee : n'importe quel compte partageait n'importe quel document.
        string vaultId = resourceType == ResourceType.Document
            ? await vaultDocuments.GetVaultIdAsync(resourceId, ct)
              ?? throw new AccessDeniedException("Document inconnu : il n'appartient a aucun vault.")
            : resourceId;

        Vault? vault = await vaults.GetByIdAsync(vaultId, ct);
        if (vault is null) throw new VaultNotFoundException(vaultId);
        if (vault.IsOwner(callerId)) return;

        ResourcePermission? acl = await permissions.GetAsync(
            ResourceType.Vault, vaultId, SubjectType.User, callerId, ct);
        if (acl?.Permission == Permission.Admin && !acl.IsExpired()) return;

        throw new AccessDeniedException("Seul l'owner ou un admin peut partager cette ressource.");
    }

    internal static Task RequireShareRightAsync(
        string callerId, string resourceType, string resourceId,
        IVaultRepository vaults, IResourcePermissionRepository permissions,
        IVaultDocumentRepository vaultDocuments, CancellationToken ct) =>
        RequireShareRightAsync(callerId, resourceType.ParseResourceType(), resourceId,
            vaults, permissions, vaultDocuments, ct);

    internal static ResourcePermissionDto ToDto(ResourcePermission p, string? displayName) =>
        new(p.Id, p.ResourceType.ToApiString(), p.ResourceId,
            p.SubjectType.ToApiString(), p.SubjectId,
            displayName, p.Permission.ToApiString(), p.GrantedBy, p.GrantedAt, p.ExpiresAt);
}
