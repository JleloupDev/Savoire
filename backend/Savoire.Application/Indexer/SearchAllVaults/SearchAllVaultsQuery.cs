// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// POST /api/v1/search : recherche globale sur les vaults que la personne
// peut lire (docs/Architecture/indexer-protocol.md, « Routes publiques »).
//
// Corps : SearchQuery + vaultIds? (sous-ensemble). Les vaults lisibles et
// servis par le pair gere sont groupes par instance ; chaque instance recoit
// POST /v1/search en parallele (Indexer:SearchParallelism au plus) ; les
// pages sont fusionnees par score (GlobalSearchMerge). Une instance en echec
// donne partial: true, pas une erreur ; toutes en echec : 503.

using System.Text.Json.Nodes;
using MediatR;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Savoire.Application.Abstractions;
using Savoire.Domain.Enums;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Indexer.SearchAllVaults;

public sealed record SearchAllVaultsQuery(string CallerId, string BodyJson) : IRequest<IndexerReply>;

public sealed class SearchAllVaultsQueryHandler(
    IOptionsMonitor<IndexerOptions>     options,
    IVaultRepository                    vaults,
    IVaultIndexerSettingRepository      settings,
    IIndexerPeerClient                  peer,
    ILogger<SearchAllVaultsQueryHandler> logger) : IRequestHandler<SearchAllVaultsQuery, IndexerReply>
{
    /// <summary>QUERY_DEFAULT_LIMIT / QUERY_MAX_LIMIT de packages/plugin-api/src/query.ts.</summary>
    private const int DefaultLimit = 50;
    private const int MaxLimit = 500;
    /// <summary>Au plus autant de vaults demandes explicitement.</summary>
    private const int MaxVaultIds = 1000;

    public async Task<IndexerReply> Handle(SearchAllVaultsQuery q, CancellationToken ct)
    {
        IndexerCallers.RequireAccount(q.CallerId);
        IndexerOptions opts = options.CurrentValue;
        if (!opts.Enabled || opts.Instances.Count == 0)
            return IndexerReply.Unavailable("Aucun pair indexeur n'est configure sur ce serveur.", opts.RetryAfterSeconds);

        if (IndexerRelay.ParseObject(q.BodyJson) is not JsonObject query)
            return IndexerReply.Error(400, IndexerErrorCodes.InvalidQuery, "Corps attendu : un objet SearchQuery.");

        // vaultIds et cursor sont ceux de la recherche globale, pas ceux d'une instance.
        HashSet<string>? wanted = null;
        if (query["vaultIds"] is JsonArray ids)
        {
            if (ids.Count > MaxVaultIds || ids.Any(n => n is not JsonValue v || !v.TryGetValue(out string? _)))
                return IndexerReply.Error(400, IndexerErrorCodes.InvalidQuery, $"vaultIds : au plus {MaxVaultIds} identifiants (texte).");
            wanted = ids.Select(n => n!.GetValue<string>()).ToHashSet(StringComparer.Ordinal);
        }
        else if (query["vaultIds"] is not null)
            return IndexerReply.Error(400, IndexerErrorCodes.InvalidQuery, "vaultIds : liste attendue.");
        query.Remove("vaultIds");

        string? cursorText = null;
        if (query["cursor"] is JsonValue cv && cv.TryGetValue(out string? c)) cursorText = c;
        else if (query["cursor"] is not null)
            return IndexerReply.Error(400, IndexerErrorCodes.InvalidCursor, "cursor : texte attendu.");
        query.Remove("cursor");

        int limit = DefaultLimit;
        if (query["limit"] is JsonValue lv)
        {
            if (!lv.TryGetValue(out int l) || l < 1 || l > MaxLimit)
                return IndexerReply.Error(400, IndexerErrorCodes.InvalidQuery, $"limit : entier de 1 a {MaxLimit}.");
            limit = l;
        }
        else if (query["limit"] is not null)
            return IndexerReply.Error(400, IndexerErrorCodes.InvalidQuery, $"limit : entier de 1 a {MaxLimit}.");

        // Vaults lisibles (proprietaire ou membre), servis par le pair gere.
        var readable = (await vaults.GetForUserAsync(q.CallerId, ct)).Select(v => v.Vault.Id);
        string[] candidates = (wanted is null ? readable : readable.Where(wanted.Contains)).Distinct().ToArray();
        var modes = await settings.GetManyAsync(candidates, ct);
        string[] managed = candidates.Where(id => modes[id].Mode == IndexerMode.Managed).ToArray();

        Dictionary<string, (IndexerInstanceOptions Instance, List<string> VaultIds)> groups = [];
        foreach (string vaultId in managed)
        {
            IndexerInstanceOptions owner = IndexerRouting.OwnerOf(vaultId, opts.Instances)!;
            if (!groups.TryGetValue(owner.Name, out var group))
                groups[owner.Name] = group = (owner, []);
            group.VaultIds.Add(vaultId);
        }

        GlobalSearchCursor state;
        if (cursorText is null) state = GlobalSearchCursor.Start(groups.Keys);
        else if (GlobalSearchCursor.Decode(cursorText) is { } decoded) state = decoded;
        else return IndexerReply.Error(400, IndexerErrorCodes.InvalidCursor, "Curseur illisible.");

        var active = groups.Where(g => state.Parts.ContainsKey(g.Key)).OrderBy(g => g.Key, StringComparer.Ordinal).ToList();
        if (active.Count == 0) return IndexerReply.Ok(EmptyResult(state.Partial).ToJsonString());

        // Appels paralleles, bornes.
        using var gate = new SemaphoreSlim(opts.SearchParallelism);
        var calls = active.Select(async g =>
        {
            await gate.WaitAsync(ct);
            try
            {
                GlobalSearchPart part = state.Parts[g.Key];
                var instanceQuery = (JsonObject)query.DeepClone();
                if (part.Cursor is not null) instanceQuery["cursor"] = part.Cursor;
                var body = new JsonObject
                {
                    ["vaultIds"] = new JsonArray(g.Value.VaultIds.Select(id => (JsonNode)JsonValue.Create(id)!).ToArray()),
                    ["query"]    = instanceQuery,
                    ["caller"]   = new JsonObject { ["userId"] = q.CallerId },
                };
                IndexerPeerResponse response = await peer.SearchAsync(g.Value.Instance, IndexerRelay.Utf8(body), ct);
                return (Name: g.Key, Part: part, VaultIds: g.Value.VaultIds, Response: response);
            }
            finally { gate.Release(); }
        }).ToList();
        var responses = await Task.WhenAll(calls);

        bool partial = state.Partial;
        var pages = new List<InstanceSearchPage>();
        var indexes = new List<JsonObject?>();
        long total = 0;
        foreach (var r in responses)
        {
            JsonObject? result = r.Response.IsSuccess ? IndexerRelay.ParseObject(r.Response.Body) : null;
            if (result is null || result["hits"] is not JsonArray hits)
            {
                // Une requete refusee l'est partout : la dire, plutot qu'un resultat vide.
                if (r.Response.Outcome == IndexerPeerOutcome.Answered && r.Response.StatusCode == 400)
                    return IndexerRelay.ToReply(r.Response, opts, resultOnly: false, logger);
                logger.LogWarning("Recherche globale : l'instance {Instance} n'a pas repondu ({Outcome} {Status})",
                    r.Name, r.Response.Outcome, r.Response.StatusCode);
                partial = true;
                continue;
            }
            var pageHits = new List<JsonObject>();
            foreach (JsonNode? node in hits)
            {
                if (node is not JsonObject hit) continue;
                // Le pair renseigne vaultId ; s'il l'oublie et qu'un seul vault etait demande, on le sait.
                if (hit["vaultId"] is null && r.VaultIds.Count == 1) hit["vaultId"] = r.VaultIds[0];
                pageHits.Add(hit);
            }
            string? next = result["next"] is JsonValue nv && nv.TryGetValue(out string? n) ? n : null;
            if (result["total"] is JsonValue tv && tv.TryGetValue(out long t)) total += t;
            indexes.Add(result["index"] as JsonObject);
            pages.Add(new InstanceSearchPage(r.Name, r.Part, pageHits, next));
        }

        if (pages.Count == 0)
            return IndexerReply.Unavailable("Aucune instance du pair indexeur n'a repondu.", opts.RetryAfterSeconds);

        (List<JsonObject> merged, Dictionary<string, GlobalSearchPart> remaining) = GlobalSearchMerge.Merge(pages, limit);
        var output = new JsonObject
        {
            ["hits"]  = new JsonArray(merged.Select(h => (JsonNode)h.DeepClone()).ToArray()),
            ["total"] = total,
            ["index"] = GlobalSearchMerge.WorstIndex(indexes),
        };
        if (remaining.Count > 0) output["next"] = new GlobalSearchCursor(remaining, partial).Encode();
        if (partial) output["partial"] = true;
        return IndexerReply.Ok(output.ToJsonString());
    }

    private static JsonObject EmptyResult(bool partial)
    {
        var empty = new JsonObject
        {
            ["hits"]  = new JsonArray(),
            ["total"] = 0,
            ["index"] = new JsonObject { ["status"] = "ready" },
        };
        if (partial) empty["partial"] = true;
        return empty;
    }
}
