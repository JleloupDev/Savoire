// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Sync.JoinDocument;

public sealed class JoinDocumentQueryHandler(
    ICrdtOpRepository ops,
    IVaultRepository  vaults) : IRequestHandler<JoinDocumentQuery, JoinDocumentResult>
{
    public async Task<JoinDocumentResult> Handle(JoinDocumentQuery q, CancellationToken ct)
    {
        IReadOnlyList<Operation> history =
            await ops.GetAllAsync(CrdtResourceType.Document, q.DocId, ct);

        string[] opStrings = history.Select(op => Convert.ToBase64String(op.OpBytes)).ToArray();

        Vault? vault = await vaults.GetByIdAsync(q.VaultId, ct);
        bool isVaultMember = vault is not null
            && (vault.IsOwner(q.CallerId)
                || await vaults.GetMemberAsync(q.VaultId, q.CallerId, ct) is not null);

        return new JoinDocumentResult(opStrings, isVaultMember);
    }
}
