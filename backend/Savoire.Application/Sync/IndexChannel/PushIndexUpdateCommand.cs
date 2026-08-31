// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Sync.IndexChannel;

/// <summary>Clé de ressource d'un canal d'index dans le log d'ops générique.</summary>
public static class IndexResource
{
    public static string Id(string vaultId, string ns) => $"index:{vaultId}:{ns}";
}

public sealed record PushIndexUpdateCommand(string VaultId, string Namespace, byte[] OpBytes)
    : IRequest;

public sealed class PushIndexUpdateCommandHandler(ICrdtOpRepository ops)
    : IRequestHandler<PushIndexUpdateCommand>
{
    public async Task Handle(PushIndexUpdateCommand cmd, CancellationToken ct)
    {
        // Le serveur est un passe-plat : il empile des octets opaques, sans
        // jamais les interpréter, exactement comme pour les documents.
        await ops.AppendAsync(
            Operation.Create(CrdtResourceType.Index,
                IndexResource.Id(cmd.VaultId, cmd.Namespace),
                clientId: "server-relay", DateTime.UtcNow, cmd.OpBytes), ct);
    }
}
