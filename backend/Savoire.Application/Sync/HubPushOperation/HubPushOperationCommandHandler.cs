// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Sync.HubPushOperation;

public sealed class HubPushOperationCommandHandler(IOperationRepository ops)
    : IRequestHandler<HubPushOperationCommand>
{
    public async Task Handle(HubPushOperationCommand cmd, CancellationToken ct)
    {
        // Access check delegated to VaultAccessBehavior (IRequiresDocumentAccess, Write).
        Operation op = Operation.Create(cmd.DocId, cmd.ClientId, DateTime.UtcNow, cmd.OpBytes);
        await ops.AppendAsync(op, ct);
    }
}
