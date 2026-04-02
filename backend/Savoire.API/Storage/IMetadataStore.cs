// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Metadata storage abstraction — Milestone 1
// Local implementation: SqliteMetadataStore.
// Stores have no knowledge of business domain — they manipulate SQL records.

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
    /// Recursively moves a folder: updates the path of all sub-folders
    /// and documents whose path starts with the old path.
    /// </summary>
    Task<(int MovedFolders, int MovedDocuments)> MoveFolderAsync(
        string folderId, string newPath, CancellationToken ct = default);

    /// <summary>
    /// Recursively deletes a folder and all its sub-folders.
    /// Soft-deletes all documents whose path starts with the folder path.
    /// Returns the number of soft-deleted documents.
    /// </summary>
    Task<int> DeleteFolderRecursiveAsync(string folderId, DateTime deletedAt, CancellationToken ct = default);

    Task<bool> FolderHasDocumentsAsync(string vaultId, string folderPath, CancellationToken ct = default);

    // ── Journal CRDT (append-only) ────────────────────────────────────────────

    Task AppendOperationAsync(OperationRecord op, CancellationToken ct = default);
    Task<IReadOnlyList<OperationRecord>> GetOperationsSinceAsync(string docId, DateTime since, CancellationToken ct = default);

    // ── Per-client state vectors ──────────────────────────────────────────────

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
