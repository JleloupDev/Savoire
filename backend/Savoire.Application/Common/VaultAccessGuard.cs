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
    IVaultDocumentRepository vaultDocuments,
    AclResolver acl) : IVaultAccessGuard
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

    /// <summary>
    /// Le membre, sauf si le droit qui l'a fait entrer a expire (droit sur le
    /// vault avec une date de fin, revue du 14/11/2026, M7). Le balayage
    /// periodique (ExpiredPermissionSweeper) le retire ensuite pour de bon.
    /// </summary>
    private async Task<VaultMember?> ActiveMemberAsync(string vaultId, string callerId, CancellationToken ct)
    {
        VaultMember? member = await vaults.GetMemberAsync(vaultId, callerId, ct);
        if (member is null) return null;
        ResourcePermission? grant = await permissions.GetAsync(ResourceType.Vault, vaultId, SubjectType.User, callerId, ct);
        return grant is not null && grant.IsExpired() ? null : member;
    }

    public async Task RequireReadAsync(string callerId, string vaultId, CancellationToken ct = default)
    {
        Vault? vault = await vaults.GetByIdAsync(vaultId, ct);
        if (vault is null) throw new VaultNotFoundException(vaultId);
        if (vault.IsOwner(callerId)) return;
        VaultMember? member = await ActiveMemberAsync(vaultId, callerId, ct);
        if (member is null) throw new VaultNotFoundException(vaultId);
    }

    public async Task RequireWriteAsync(string callerId, string vaultId, CancellationToken ct = default)
    {
        Vault? vault = await vaults.GetByIdAsync(vaultId, ct);
        if (vault is null) throw new VaultNotFoundException(vaultId);
        if (vault.IsOwner(callerId)) return;
        VaultMember? member = await ActiveMemberAsync(vaultId, callerId, ct);
        if (member is null) throw new VaultNotFoundException(vaultId);
        if (member.Role == VaultRole.Viewer)
            throw new AccessDeniedException("Vault viewers cannot modify this vault.");
    }

    /// <summary>
    /// Lire un document : le droit effectif, herite du vault et des dossiers,
    /// ou surcharge (voir AclResolver).
    /// </summary>
    public async Task RequireDocumentReadAsync(string callerId, string vaultId, string docId, CancellationToken ct = default)
    {
        await RequireDocumentInVaultAsync(vaultId, docId, ct);
        Vault vault = await vaults.GetByIdAsync(vaultId, ct) ?? throw new VaultNotFoundException(vaultId);
        AclDecision decision = await acl.ForDocumentAsync(callerId, vault, docId, ct);
        if (decision.Permission is null) throw new VaultNotFoundException(vaultId);
    }

    /// <summary>Ecrire un document : droit effectif d'ecriture (redacteur, admin), herite ou surcharge.</summary>
    public async Task RequireDocumentWriteAsync(string callerId, string vaultId, string docId, CancellationToken ct = default)
    {
        await RequireDocumentInVaultAsync(vaultId, docId, ct);
        Vault vault = await vaults.GetByIdAsync(vaultId, ct) ?? throw new VaultNotFoundException(vaultId);
        AclDecision decision = await acl.ForDocumentAsync(callerId, vault, docId, ct);
        if (decision.Permission is null) throw new VaultNotFoundException(vaultId);
        if (decision.Permission == Permission.Read)
            throw new AccessDeniedException("Lecture seule sur ce document.");
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
