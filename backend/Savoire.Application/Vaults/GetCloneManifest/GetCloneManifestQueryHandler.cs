// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Repositories;
using Savoire.Domain.ValueObjects;

namespace Savoire.Application.Vaults.GetCloneManifest;

public class GetCloneManifestQueryHandler(
    IVaultRepository    vaults,
    IDocumentRepository documents,
    IFolderRepository   folders)
    : IRequestHandler<GetCloneManifestQuery, CloneManifestDto>
{
    public async Task<CloneManifestDto> Handle(GetCloneManifestQuery q, CancellationToken ct)
    {
        // Access check delegated to VaultAccessBehavior (RequiredAccess = Read).

        Vault vault = await vaults.GetByIdAsync(q.VaultId, ct)
            ?? throw new VaultNotFoundException(q.VaultId);

        IReadOnlyList<Document> docs      = await documents.ListAsync(q.VaultId, ct: ct);
        IReadOnlyList<Folder>   folderList = await folders.ListAsync(q.VaultId, ct);
        VaultStats stats = await vaults.GetStatsAsync(q.VaultId, ct);

        return new CloneManifestDto(
            VaultId:        q.VaultId,
            Name:           vault.Name,
            LocalPath:      q.LocalPath,
            Folders:        folderList.Select(f => new CloneManifestFolderDto(f.Id, f.Path)).ToList(),
            Documents:      docs.Select(d => new CloneManifestDocumentDto(
                                d.Id, d.Path, d.Title, d.Hash, d.UpdatedAt, d.SizeBytes)).ToList(),
            TotalDocuments: stats.DocumentCount,
            TotalSizeBytes: stats.SizeBytes
        );
    }
}
