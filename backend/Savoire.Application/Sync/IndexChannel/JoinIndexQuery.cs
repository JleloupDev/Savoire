// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Sync.IndexChannel;

public record JoinIndexResult(string[] Ops);

public sealed record JoinIndexQuery(string VaultId, string Namespace) : IRequest<JoinIndexResult>;

public sealed class JoinIndexQueryHandler(ICrdtOpRepository ops)
    : IRequestHandler<JoinIndexQuery, JoinIndexResult>
{
    public async Task<JoinIndexResult> Handle(JoinIndexQuery q, CancellationToken ct)
    {
        var stored = await ops.GetAllAsync(
            CrdtResourceType.Index, IndexResource.Id(q.VaultId, q.Namespace), ct);
        return new JoinIndexResult([.. stored.Select(o => Convert.ToBase64String(o.OpBytes))]);
    }
}
