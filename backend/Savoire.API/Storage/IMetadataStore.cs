// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Abstraction de stockage des métadonnées — Milestone 1
// Implémentation locale : SqliteMetadataStore.
// Les stores ne connaissent pas le domaine métier — ils manipulent des enregistrements SQL.

using Savoire.Server.Models;

namespace Savoire.Server.Storage;

public interface IMetadataStore
{
    // ── Documents ──────────────────────────────────────────────────────────────

    Task<DocumentRecord?> GetDocumentAsync(string docId, CancellationToken ct = default);
    Task<DocumentRecord?> GetDocumentByPathAsync(string vaultId, string path, CancellationToken ct = default);

    Task<IReadOnlyList<DocumentRecord>> ListVaultDocumentsAsync(
        string vaultId,
        string? folderPrefix = null,
        bool includeDeleted = false,
        CancellationToken ct = default);

    Task UpsertDocumentAsync(DocumentRecord doc, CancellationToken ct = default);
    Task RenameDocumentAsync(string docId, string newPath, CancellationToken ct = default);
    Task SoftDeleteDocumentAsync(string docId, CancellationToken ct = default);

    Task<IReadOnlyList<DocumentRecord>> GetDocumentChangesSinceAsync(
        string vaultId, DateTime since, CancellationToken ct = default);

    // ── Dossiers ───────────────────────────────────────────────────────────────

    Task CreateFolderAsync(FolderRecord folder, CancellationToken ct = default);
    Task<FolderRecord?> GetFolderAsync(string folderId, CancellationToken ct = default);
    Task<FolderRecord?> GetFolderByPathAsync(string vaultId, string path, CancellationToken ct = default);
    Task<IReadOnlyList<FolderRecord>> ListVaultFoldersAsync(string vaultId, CancellationToken ct = default);

    /// <summary>
    /// Déplace récursivement un dossier : met à jour le path de tous les sous-dossiers
    /// et documents dont le path commence par l'ancien path.
    /// </summary>
    Task<(int MovedFolders, int MovedDocuments)> MoveFolderAsync(
        string folderId, string newPath, CancellationToken ct = default);

    /// <summary>
    /// Supprime récursivement un dossier et tous ses sous-dossiers.
    /// Soft-delete tous les documents dont le path commence par le path du dossier.
    /// Retourne le nombre de documents soft-deletés.
    /// </summary>
    Task<int> DeleteFolderRecursiveAsync(string folderId, DateTime deletedAt, CancellationToken ct = default);

    Task<bool> FolderHasDocumentsAsync(string vaultId, string folderPath, CancellationToken ct = default);

    // ── Journal CRDT (append-only) ────────────────────────────────────────────

    Task AppendOperationAsync(OperationRecord op, CancellationToken ct = default);
    Task<IReadOnlyList<OperationRecord>> GetOperationsSinceAsync(string docId, DateTime since, CancellationToken ct = default);

    // ── Vecteurs d'état par client ────────────────────────────────────────────

    Task<byte[]?> GetSyncVectorAsync(string docId, string clientId, CancellationToken ct = default);
    Task SetSyncVectorAsync(string docId, string clientId, byte[] vector, CancellationToken ct = default);

    // ── Vaults ────────────────────────────────────────────────────────────────

    Task<VaultRecord?> GetVaultAsync(string vaultId, CancellationToken ct = default);
    Task<IReadOnlyList<VaultMember>> GetVaultMembersAsync(string vaultId, CancellationToken ct = default);
    Task CreateVaultAsync(VaultRecord vault, CancellationToken ct = default);
    Task RenameVaultAsync(string vaultId, string newName, CancellationToken ct = default);
    Task DeleteVaultAsync(string vaultId, CancellationToken ct = default);

    Task<IReadOnlyList<(VaultRecord Vault, string Role)>> GetVaultsForUserAsync(
        string userId, CancellationToken ct = default);

    Task<VaultStats> GetVaultStatsAsync(string vaultId, CancellationToken ct = default);

    // ── Membres ───────────────────────────────────────────────────────────────

    Task AddVaultMemberAsync(VaultMember member, CancellationToken ct = default);
    Task<VaultMember?> GetVaultMemberAsync(string vaultId, string userId, CancellationToken ct = default);
    Task RemoveMemberAsync(string vaultId, string userId, CancellationToken ct = default);
}
