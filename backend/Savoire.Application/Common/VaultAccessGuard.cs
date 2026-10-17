// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Savoire.Domain.Aggregates;
using Savoire.Domain.Enums;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Common;

public sealed class VaultAccessGuard(
    IVaultRepository vaults,
    IResourcePermissionRepository permissions,
    IVaultDocumentRepository vaultDocuments) : IVaultAccessGuard
{
    /// <summary>
    /// Le document doit etre inscrit dans le vault annonce. Sans ce controle,
    /// un compte membre de SON vault pouvait annoncer ce vault avec
    /// l'identifiant d'un document d'un autre vault.
    /// </summary>
    private async Task RequireDocumentInVaultAsync(string vaultId, string docId, CancellationToken ct)
    {
        string? owner = await vaultDocuments.GetVaultIdAsync(docId, ct);
        if (owner != vaultId) throw new DocumentNotInVaultException(vaultId);
    }

    public async Task RequireReadAsync(string callerId, string vaultId, CancellationToken ct = default)
    {
        Vault? vault = await vaults.GetByIdAsync(vaultId, ct);
        if (vault is null) throw new VaultNotFoundException(vaultId);
        if (vault.IsOwner(callerId)) return;
        VaultMember? member = await vaults.GetMemberAsync(vaultId, callerId, ct);
        if (member is null) throw new VaultNotFoundException(vaultId);
    }

    public async Task RequireWriteAsync(string callerId, string vaultId, CancellationToken ct = default)
    {
        Vault? vault = await vaults.GetByIdAsync(vaultId, ct);
        if (vault is null) throw new VaultNotFoundException(vaultId);
        if (vault.IsOwner(callerId)) return;
        VaultMember? member = await vaults.GetMemberAsync(vaultId, callerId, ct);
        if (member is null) throw new VaultNotFoundException(vaultId);
        if (member.Role == VaultRole.Viewer)
            throw new AccessDeniedException("Vault viewers cannot modify this vault.");
    }

    public async Task RequireDocumentReadAsync(string callerId, string vaultId, string docId, CancellationToken ct = default)
    {
        await RequireDocumentInVaultAsync(vaultId, docId, ct);
        Vault? vault = await vaults.GetByIdAsync(vaultId, ct);
        if (vault is null) throw new VaultNotFoundException(vaultId);
        if (vault.IsOwner(callerId)) return;

        VaultMember? member = await vaults.GetMemberAsync(vaultId, callerId, ct);
        if (member is not null) return;

        // Not a vault member — check for a document-level permission.
        ResourcePermission? perm = await permissions.GetAsync(
            ResourceType.Document, docId,
            SubjectType.User, callerId,
            ct);

        if (perm is null || perm.IsExpired())
            throw new VaultNotFoundException(vaultId);
    }

    public async Task RequireDocumentWriteAsync(string callerId, string vaultId, string docId, CancellationToken ct = default)
    {
        await RequireDocumentInVaultAsync(vaultId, docId, ct);
        Vault? vault = await vaults.GetByIdAsync(vaultId, ct);
        if (vault is null) throw new VaultNotFoundException(vaultId);
        if (vault.IsOwner(callerId)) return;

        VaultMember? member = await vaults.GetMemberAsync(vaultId, callerId, ct);
        if (member is not null)
        {
            if (member.Role == VaultRole.Viewer)
                throw new AccessDeniedException("Vault viewers cannot modify this document.");
            return;
        }

        // Not a vault member — require write or admin document-level permission.
        ResourcePermission? perm = await permissions.GetAsync(
            ResourceType.Document, docId,
            SubjectType.User, callerId,
            ct);

        if (perm is null || perm.IsExpired())
            throw new VaultNotFoundException(vaultId);

        if (perm.Permission == Permission.Read)
            throw new AccessDeniedException("Read-only permission is insufficient to modify this document.");
    }

    public async Task RequireAdminAsync(string callerId, string vaultId, CancellationToken ct = default)
    {
        Vault? vault = await vaults.GetByIdAsync(vaultId, ct);
        if (vault is null) throw new VaultNotFoundException(vaultId);
        if (vault.IsOwner(callerId)) return;

        ResourcePermission? perm = await permissions.GetAsync(
            ResourceType.Vault, vaultId, SubjectType.User, callerId, ct);
        if (perm is null || perm.IsExpired() || perm.Permission != Permission.Admin)
            throw new AccessDeniedException("Admin permission is required.");
    }
}
