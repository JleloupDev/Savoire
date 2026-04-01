// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Domain.Aggregates;
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
        // Vérifie que le caller est autorisé à partager cette ressource
        await RequireShareRightAsync(cmd.CallerId, cmd.ResourceType, cmd.ResourceId, vaults, documents, permissions, ct);

        // Upsert: remplace si déjà présent
        ResourcePermission? existing = await permissions.GetAsync(
            cmd.ResourceType, cmd.ResourceId, "user", cmd.TargetUserId, ct);
        if (existing is not null)
            await permissions.DeleteAsync(existing.Id, ct);

        ResourcePermission perm = ResourcePermission.Create(
            cmd.ResourceType, cmd.ResourceId,
            "user", cmd.TargetUserId,
            cmd.Permission, cmd.CallerId, cmd.ExpiresAt);
        await permissions.AddAsync(perm, ct);

        string? displayName = (await users.GetByIdAsync(cmd.TargetUserId, ct))?.DisplayName;
        return ToDto(perm, displayName);
    }

    /// <summary>
    /// Seul l'owner d'un vault peut partager le vault (ou ses documents).
    /// </summary>
    internal static async Task RequireShareRightAsync(
        string callerId, string resourceType, string resourceId,
        IVaultRepository vaults, IDocumentRepository documents,
        IResourcePermissionRepository permissions, CancellationToken ct)
    {
        string vaultId = resourceType switch
        {
            "vault"    => resourceId,
            "document" => await ResolveVaultIdFromDocumentAsync(resourceId, documents, ct),
            _          => throw new ArgumentException($"ResourceType inconnu : {resourceType}")
        };

        Vault? vault = await vaults.GetByIdAsync(vaultId, ct);
        if (vault is null) throw new VaultNotFoundException(vaultId);
        if (vault.IsOwner(callerId)) return;

        // Un admin ACL peut aussi partager
        ResourcePermission? acl = await permissions.GetAsync(
            "vault", vaultId, "user", callerId, ct);
        if (acl?.Permission == "admin" && !acl.IsExpired()) return;

        throw new AccessDeniedException("Seul l'owner ou un admin peut partager cette ressource.");
    }

    private static async Task<string> ResolveVaultIdFromDocumentAsync(
        string docId, IDocumentRepository documents, CancellationToken ct)
    {
        Document? doc = await documents.GetByIdAsync(docId, ct);
        if (doc is null) throw new DocumentNotFoundException(docId);
        return doc.VaultId;
    }

    internal static ResourcePermissionDto ToDto(ResourcePermission p, string? displayName) =>
        new(p.Id, p.ResourceType, p.ResourceId, p.SubjectType, p.SubjectId,
            displayName, p.Permission, p.GrantedBy, p.GrantedAt, p.ExpiresAt);
}
