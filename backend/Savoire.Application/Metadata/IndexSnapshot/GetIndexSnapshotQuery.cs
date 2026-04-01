// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Metadata.IndexSnapshot;

public record GetIndexSnapshotQuery(string VaultId, string Namespace, string CallerId)
    : IRequest<IndexSnapshotDto?>;

public record GetIndexSnapshotQueryHandler(IIndexSnapshotRepository Snapshots)
    : IRequestHandler<GetIndexSnapshotQuery, IndexSnapshotDto?>
{
    public async Task<IndexSnapshotDto?> Handle(GetIndexSnapshotQuery query, CancellationToken ct)
    {
        var snap = await Snapshots.GetLatestAsync(query.VaultId, query.Namespace, ct);
        if (snap is null) return null;
        return new IndexSnapshotDto(snap.Namespace, snap.ProcessedSeq, snap.Data, snap.CreatedAt);
    }
}
