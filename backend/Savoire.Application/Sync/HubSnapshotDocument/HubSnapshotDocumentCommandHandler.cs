// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Sync.HubSnapshotDocument;

public class HubSnapshotDocumentCommandHandler(IOperationRepository ops)
    : IRequestHandler<HubSnapshotDocumentCommand>
{
    public async Task Handle(HubSnapshotDocumentCommand cmd, CancellationToken ct)
    {
        // Access check delegated to VaultAccessBehavior (RequiredAccess = Read).
        await ops.CompactAsync(cmd.DocId, cmd.SnapshotBytes, force: true, ct);
    }
}
