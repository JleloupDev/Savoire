// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Sync.PushVaultOperation;

public sealed class PushVaultOperationCommandHandler(ICrdtOpRepository ops)
    : IRequestHandler<PushVaultOperationCommand>
{
    public async Task Handle(PushVaultOperationCommand cmd, CancellationToken ct)
    {
        Operation op = Operation.Create(CrdtResourceType.Vault, $"vault:{cmd.VaultId}", "vault-client", DateTime.UtcNow, cmd.OpBytes);
        await ops.AppendAsync(op, ct);
    }
}
