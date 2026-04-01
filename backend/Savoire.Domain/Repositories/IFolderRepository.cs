// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Savoire.Domain.Aggregates;

namespace Savoire.Domain.Repositories;

public interface IFolderRepository
{
    Task<Folder?> GetByIdAsync(string folderId, CancellationToken ct = default);
    Task<Folder?> GetByPathAsync(string vaultId, string path, CancellationToken ct = default);
    Task<IReadOnlyList<Folder>> ListAsync(string vaultId, CancellationToken ct = default);
    Task<bool> HasDocumentsAsync(string vaultId, string folderPath, CancellationToken ct = default);
    Task AddAsync(Folder folder, CancellationToken ct = default);
    Task<(int MovedFolders, int MovedDocuments)> MoveAsync(string folderId, string newPath, CancellationToken ct = default);
    Task<int> DeleteRecursiveAsync(string folderId, DateTime deletedAt, CancellationToken ct = default);
}
