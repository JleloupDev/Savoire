// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Sync.JoinDocument;

public class JoinDocumentQueryHandler(
    IDocumentRepository  docs,
    IOperationRepository ops) : IRequestHandler<JoinDocumentQuery, string[]>
{
    public async Task<string[]> Handle(JoinDocumentQuery q, CancellationToken ct)
    {
        // Access check delegated to VaultAccessBehavior (RequiredAccess = Read).

        Document? existing = await docs.GetByIdAsync(q.DocId, ct);
        if (existing is null)
        {
            Document newDoc = Document.Create(q.VaultId, q.DocId, null, 0, "");
            await docs.AddAsync(newDoc, ct);
        }

        IReadOnlyList<Operation> history =
            await ops.GetSinceAsync(q.DocId, DateTime.MinValue, ct);

        return history.Select(op => Convert.ToBase64String(op.OpBytes)).ToArray();
    }
}
