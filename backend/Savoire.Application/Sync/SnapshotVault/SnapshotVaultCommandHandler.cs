// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Sync.SnapshotVault;

public sealed class SnapshotVaultCommandHandler(ICrdtOpRepository ops)
    : IRequestHandler<SnapshotVaultCommand>
{
    public Task Handle(SnapshotVaultCommand cmd, CancellationToken ct) =>
        ops.CompactAsync(CrdtResourceType.Vault, $"vault:{cmd.VaultId}", cmd.SnapshotBytes, force: true, ct);
}
