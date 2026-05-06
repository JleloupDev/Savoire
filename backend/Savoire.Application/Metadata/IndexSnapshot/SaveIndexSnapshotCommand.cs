// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Metadata.IndexSnapshot;

public record SaveIndexSnapshotCommand(
    string VaultId,
    string Namespace,
    long   ProcessedSeq,
    string Data,
    string CallerId
) : IRequest, IRequiresVaultAccess
{
    public VaultAccessLevel RequiredAccess => VaultAccessLevel.Write;
}

public class SaveIndexSnapshotCommandHandler(IIndexSnapshotRepository snapshots)
    : IRequestHandler<SaveIndexSnapshotCommand>
{
    public async Task Handle(SaveIndexSnapshotCommand cmd, CancellationToken ct)
    {
        var snap = Domain.Aggregates.IndexSnapshot.Create(
            cmd.VaultId, cmd.Namespace, cmd.ProcessedSeq, cmd.Data);
        await snapshots.SaveAsync(snap, ct);
    }
}
