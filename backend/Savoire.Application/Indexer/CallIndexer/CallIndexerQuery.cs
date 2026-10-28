// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// POST /api/v1/vaults/{vaultId}/index/{capability}/{method}
//
// Appel d'un pouvoir du pair indexeur (query.run, search.run, links.*...).
// Le backend ne connait pas les pouvoirs : il verifie le droit de LIRE le
// vault, ajoute l'appelant (jamais pris du client) et relaie a l'instance qui
// possede le vault. Un nouveau pouvoir ne demande rien ici.

using MediatR;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Savoire.Application.Abstractions;
using Savoire.Application.Common;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Indexer.CallIndexer;

public sealed record CallIndexerQuery(string CallerId, string VaultId, string Capability, string Method, string ParamsJson)
    : IRequest<IndexerReply>, IRequiresVaultAccess
{
    public VaultAccessLevel RequiredAccess => VaultAccessLevel.Read;
}

public sealed class CallIndexerQueryHandler(
    IOptionsMonitor<IndexerOptions>  options,
    IVaultIndexerSettingRepository   settings,
    IIndexerPeerClient               peer,
    ILogger<CallIndexerQueryHandler> logger) : IRequestHandler<CallIndexerQuery, IndexerReply>
{
    public async Task<IndexerReply> Handle(CallIndexerQuery q, CancellationToken ct)
    {
        IndexerCallers.RequireAccount(q.CallerId);
        IndexerOptions opts = options.CurrentValue;
        IndexerReply? refused = await IndexerRelay.CheckManagedAsync(opts, settings, q.VaultId, ct);
        if (refused is not null) return refused;

        byte[] body = IndexerRelay.CallBody(q.Capability, q.Method, q.ParamsJson, q.CallerId);
        IndexerInstanceOptions owner = IndexerRouting.OwnerOf(q.VaultId, opts.Instances)!;
        IndexerPeerResponse response = await peer.CallAsync(owner, q.VaultId, body, ct);

        // 409 not_owner : la liste des instances a change d'un cote ou de
        // l'autre. Recalculer avec la configuration courante, et reessayer
        // une fois ; un second refus devient 503 (routage en transition).
        if (IndexerRelay.IsNotOwner(response))
        {
            opts = options.CurrentValue;
            IndexerInstanceOptions? again = IndexerRouting.OwnerOf(q.VaultId, opts.Instances);
            logger.LogInformation("Pair indexeur : {Instance} ne possede pas {VaultId}, nouvel essai vers {Again}",
                owner.Name, q.VaultId, again?.Name);
            if (again is null)
                return IndexerReply.Unavailable("Aucun pair indexeur n'est configure sur ce serveur.", opts.RetryAfterSeconds);
            response = await peer.CallAsync(again, q.VaultId, body, ct);
        }

        return IndexerRelay.ToReply(response, opts, resultOnly: true, logger);
    }
}
