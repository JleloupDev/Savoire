// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Enums;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Repositories;
using Savoire.Domain.Services;

namespace Savoire.Application.Sharing.GrantPermission;

public class GrantPermissionCommandHandler(
    IVaultRepository              vaults,
    IDocumentRepository           documents,
    IResourcePermissionRepository permissions,
    IUserLookupService            users)
    : IRequestHandler<GrantPermissionCommand, ResourcePermissionDto>
{
    public async Task<ResourcePermissionDto> Handle(
        GrantPermissionCommand cmd, CancellationToken ct)
    {
        ResourceType resourceType = cmd.ResourceType.ParseResourceType();
        Permission   permission   = cmd.Permission.ParsePermission();

        // Verify that the caller is authorized to share this resource
        await RequireShareRightAsync(cmd.CallerId, resourceType, cmd.ResourceId, vaults, documents, permissions, ct);

        // Upsert: replace if already present
        ResourcePermission? existing = await permissions.GetAsync(
            resourceType, cmd.ResourceId, SubjectType.User, cmd.TargetUserId, ct);
        if (existing is not null)
            await permissions.DeleteAsync(existing.Id, ct);

        ResourcePermission perm = ResourcePermission.Create(
            resourceType, cmd.ResourceId,
            SubjectType.User, cmd.TargetUserId,
            permission, cmd.CallerId, cmd.ExpiresAt);
        await permissions.AddAsync(perm, ct);

        // Vault grants must also appear in vault_members so GetForUserAsync returns the vault.
        if (resourceType == ResourceType.Vault)
        {
            VaultRole role = permission == Permission.Read ? VaultRole.Viewer : VaultRole.Editor;
            await vaults.AddMemberAsync(
                new VaultMember(cmd.ResourceId, cmd.TargetUserId, role, DateTime.UtcNow), ct);
        }

        string? displayName = (await users.GetByIdAsync(cmd.TargetUserId, ct))?.DisplayName;
        return ToDto(perm, displayName);
    }

    /// <summary>
    /// Only the vault owner can share the vault (or its documents).
    /// </summary>
    internal static async Task RequireShareRightAsync(
        string callerId, ResourceType resourceType, string resourceId,
        IVaultRepository vaults, IDocumentRepository documents,
        IResourcePermissionRepository permissions, CancellationToken ct)
    {
        string vaultId = resourceType switch
        {
            ResourceType.Vault    => resourceId,
            ResourceType.Document => await ResolveVaultIdFromDocumentAsync(resourceId, documents, ct),
            _                     => throw new ArgumentException($"ResourceType inconnu : {resourceType}")
        };

        Vault? vault = await vaults.GetByIdAsync(vaultId, ct);
        if (vault is null) throw new VaultNotFoundException(vaultId);
        if (vault.IsOwner(callerId)) return;

        // An ACL admin can also share
        ResourcePermission? acl = await permissions.GetAsync(
            ResourceType.Vault, vaultId, SubjectType.User, callerId, ct);
        if (acl?.Permission == Permission.Admin && !acl.IsExpired()) return;

        throw new AccessDeniedException("Seul l'owner ou un admin peut partager cette ressource.");
    }

    // Overload accepting string resourceType — called from CreateShareLinkCommandHandler
    internal static Task RequireShareRightAsync(
        string callerId, string resourceType, string resourceId,
        IVaultRepository vaults, IDocumentRepository documents,
        IResourcePermissionRepository permissions, CancellationToken ct) =>
        RequireShareRightAsync(callerId, resourceType.ParseResourceType(), resourceId,
            vaults, documents, permissions, ct);

    private static async Task<string> ResolveVaultIdFromDocumentAsync(
        string docId, IDocumentRepository documents, CancellationToken ct)
    {
        Document? doc = await documents.GetByIdAsync(docId, ct);
        if (doc is null) throw new DocumentNotFoundException(docId);
        return doc.VaultId;
    }

    internal static ResourcePermissionDto ToDto(ResourcePermission p, string? displayName) =>
        new(p.Id, p.ResourceType.ToApiString(), p.ResourceId,
            p.SubjectType.ToApiString(), p.SubjectId,
            displayName, p.Permission.ToApiString(), p.GrantedBy, p.GrantedAt, p.ExpiresAt);
}
