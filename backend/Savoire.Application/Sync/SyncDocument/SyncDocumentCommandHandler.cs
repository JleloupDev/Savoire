// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Sync.SyncDocument;

public class SyncDocumentCommandHandler(
    IDocumentRepository  documents,
    IOperationRepository operations)
    : IRequestHandler<SyncDocumentCommand, SyncResponseDto>
{
    public async Task<SyncResponseDto> Handle(SyncDocumentCommand cmd, CancellationToken ct)
    {
        // Access check delegated to VaultAccessBehavior (RequiredAccess = Read).

        Document? doc = await documents.GetByIdAsync(cmd.DocId, ct);
        if (doc is null || doc.VaultId != cmd.VaultId)
            throw new DocumentNotFoundException(cmd.DocId);

        // TODO: use stateVector to return only missing ops — see GitHub issue "Sync: implement stateVector delta"
        IReadOnlyList<Operation> ops =
            await operations.GetSinceAsync(cmd.DocId, DateTime.MinValue, ct);

        byte[][] missingOps = ops.Select(o => o.OpBytes).ToArray();

        if (cmd.Request.StateVector.Length > 0)
            await operations.SetSyncVectorAsync(cmd.DocId, cmd.Request.ClientId, cmd.Request.StateVector, ct);

        return new SyncResponseDto(missingOps, Array.Empty<byte>());
    }
}
