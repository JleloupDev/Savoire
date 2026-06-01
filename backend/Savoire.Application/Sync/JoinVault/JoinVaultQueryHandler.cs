// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Sync.JoinVault;

public sealed class JoinVaultQueryHandler(ICrdtOpRepository ops)
    : IRequestHandler<JoinVaultQuery, JoinVaultResult>
{
    public async Task<JoinVaultResult> Handle(JoinVaultQuery q, CancellationToken ct)
    {
        IReadOnlyList<Operation> history = await ops.GetAllAsync(CrdtResourceType.Vault, $"vault:{q.VaultId}", ct);
        string[] opStrings = history.Select(o => Convert.ToBase64String(o.OpBytes)).ToArray();
        return new JoinVaultResult(opStrings);
    }
}
