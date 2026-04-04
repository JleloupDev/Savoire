// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Enums;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Sync.GetSyncStatus;

public class GetSyncStatusQueryHandler(IDocumentRepository documents)
    : IRequestHandler<GetSyncStatusQuery, SyncStatusDto>
{
    public async Task<SyncStatusDto> Handle(GetSyncStatusQuery q, CancellationToken ct)
    {
        // Access check delegated to VaultAccessBehavior (RequiredAccess = Read).

        IReadOnlyList<Document> changes =
            await documents.GetChangedSinceAsync(q.VaultId, q.Since, ct);

        var changeDtos = changes.Select(d => new SyncChangeDto(
            DocId:      d.Id,
            Path:       d.Path,
            ChangeType: ResolveChangeType(d, q.Since).ToApiString(),
            Hash:       d.Hash,
            UpdatedAt:  d.DeletedAt ?? d.UpdatedAt
        )).ToList();

        return new SyncStatusDto(Since: q.Since, CheckedAt: DateTime.UtcNow, Changes: changeDtos);
    }

    private static SyncChangeType ResolveChangeType(Document d, DateTime since) =>
        d.DeletedAt.HasValue  ? SyncChangeType.Deleted :
        d.CreatedAt >= since  ? SyncChangeType.Created :
                                SyncChangeType.Modified;
}
