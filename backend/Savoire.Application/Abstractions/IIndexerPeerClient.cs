// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Client de l'API du pair indexeur (docs/Architecture/indexer-protocol.md,
// « API du pair »). Realise dans Infrastructure par HttpIndexerPeerClient :
// jeton de service, delai (Indexer:TimeoutMs), reponse bornee.

using Savoire.Application.Indexer;

namespace Savoire.Application.Abstractions;

public interface IIndexerPeerClient
{
    /// <summary>POST {url}/v1/vaults/{vaultId}/call, corps JSON deja forme.</summary>
    Task<IndexerPeerResponse> CallAsync(IndexerInstanceOptions instance, string vaultId, byte[] jsonBody, CancellationToken ct = default);

    /// <summary>POST {url}/v1/search, corps JSON deja forme.</summary>
    Task<IndexerPeerResponse> SearchAsync(IndexerInstanceOptions instance, byte[] jsonBody, CancellationToken ct = default);

    /// <summary>GET {url}/v1/vaults/{vaultId}/status.</summary>
    Task<IndexerPeerResponse> StatusAsync(IndexerInstanceOptions instance, string vaultId, CancellationToken ct = default);
}

public enum IndexerPeerOutcome
{
    /// <summary>Le pair a repondu (StatusCode, Body).</summary>
    Answered,
    /// <summary>Pair injoignable (connexion refusee, nom inconnu...).</summary>
    Unreachable,
    /// <summary>Pas de reponse dans le delai.</summary>
    TimedOut,
    /// <summary>Reponse plus grosse que Indexer:MaxResponseBytes.</summary>
    TooLarge,
}

public sealed record IndexerPeerResponse(IndexerPeerOutcome Outcome, int StatusCode, string? Body, TimeSpan? RetryAfter)
{
    public bool IsSuccess => Outcome == IndexerPeerOutcome.Answered && StatusCode is >= 200 and < 300;

    public static IndexerPeerResponse Failed(IndexerPeerOutcome outcome) => new(outcome, 0, null, null);
}
