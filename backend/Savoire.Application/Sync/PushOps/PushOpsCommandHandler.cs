// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Sync.PushOps;

public class PushOpsCommandHandler(
    IDocumentRepository  documents,
    IOperationRepository operations)
    : IRequestHandler<PushOpsCommand>
{
    public async Task Handle(PushOpsCommand cmd, CancellationToken ct)
    {
        // Access check delegated to VaultAccessBehavior (IRequiresDocumentAccess, Write).

        Document? doc = await documents.GetByIdAsync(cmd.DocId, ct);
        if (doc is null || doc.VaultId != cmd.VaultId)
            throw new DocumentNotFoundException(cmd.DocId);

        Operation op = Operation.Create(cmd.DocId, cmd.Request.ClientId,
            cmd.Request.ProducedAt, cmd.Request.Ops);
        await operations.AppendAsync(op, ct);
    }
}
