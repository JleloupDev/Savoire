// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// GET /api/v1/vaults/{vaultId}/indexer : le pair qui sert le vault, et l'etat
// de son index. Lisible par les membres du vault.

using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using MediatR;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Savoire.Application.Abstractions;
using Savoire.Application.Common;
using Savoire.Domain.Enums;
using Savoire.Domain.ReadModels;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Indexer.VaultIndexer;

/// <summary>
/// Reglage du vault. <c>State</c> : etat de l'index rendu par le pair gere
/// (IndexState + seq, docs, bytes), ou { status: "unavailable" } ; absent
/// pour un pair d'organisation, que le serveur ne connait pas.
/// </summary>
public sealed record VaultIndexerDto(
    string Mode,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Url,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] JsonObject? State)
{
    public static VaultIndexerDto From(VaultIndexerSetting s, JsonObject? state) =>
        new(s.Mode.ToApiString(), s.Mode == IndexerMode.Organization ? s.Url : null, state);
}

public sealed record GetVaultIndexerQuery(string CallerId, string VaultId)
    : IRequest<VaultIndexerDto>, IRequiresVaultAccess
{
    public VaultAccessLevel RequiredAccess => VaultAccessLevel.Read;
}

public sealed class GetVaultIndexerQueryHandler(
    IOptionsMonitor<IndexerOptions>      options,
    IVaultIndexerSettingRepository       settings,
    IIndexerPeerClient                   peer,
    ILogger<GetVaultIndexerQueryHandler> logger) : IRequestHandler<GetVaultIndexerQuery, VaultIndexerDto>
{
    public async Task<VaultIndexerDto> Handle(GetVaultIndexerQuery q, CancellationToken ct)
    {
        IndexerCallers.RequireAccount(q.CallerId);
        VaultIndexerSetting setting = await settings.GetAsync(q.VaultId, ct);
        if (setting.Mode == IndexerMode.Organization) return VaultIndexerDto.From(setting, null);

        IndexerOptions opts = options.CurrentValue;
        JsonObject? state = null;
        if (setting.Mode == IndexerMode.Managed && opts.Enabled && IndexerRouting.OwnerOf(q.VaultId, opts.Instances) is { } owner)
        {
            IndexerPeerResponse response = await peer.StatusAsync(owner, q.VaultId, ct);
            state = response.IsSuccess ? IndexerRelay.ParseObject(response.Body) : null;
            if (state is null)
                logger.LogInformation("Etat de l'index de {VaultId} : pair {Instance} indisponible ({Outcome} {Status})",
                    q.VaultId, owner.Name, response.Outcome, response.StatusCode);
        }
        return VaultIndexerDto.From(setting, state ?? new JsonObject { ["status"] = "unavailable" });
    }
}
