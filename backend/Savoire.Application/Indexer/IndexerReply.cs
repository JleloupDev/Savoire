// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Reponse d'une route publique du pair indexeur, telle que le controleur
// l'ecrit : statut, corps JSON, Retry-After eventuel. Les erreurs ont la forme
// du protocole : { error: { code, message } }.

using System.Text.Json.Nodes;
using Savoire.Domain.Enums;
using Savoire.Domain.ReadModels;

namespace Savoire.Application.Indexer;

public sealed record IndexerReply(int StatusCode, string Json, int? RetryAfterSeconds = null)
{
    public bool IsSuccess => StatusCode is >= 200 and < 300;

    public static IndexerReply Ok(string json) => new(200, json);

    public static IndexerReply Error(int statusCode, string code, string message, int? retryAfterSeconds = null) =>
        new(statusCode, ErrorJson(code, message).ToJsonString(), retryAfterSeconds);

    /// <summary>Pair absent, indisponible ou vault sans pair : 503 + Retry-After.</summary>
    public static IndexerReply Unavailable(string message, int retryAfterSeconds) =>
        Error(503, IndexerErrorCodes.Unavailable, message, retryAfterSeconds);

    /// <summary>Corps d'erreur du protocole.</summary>
    public static JsonObject ErrorJson(string code, string message) =>
        new() { ["error"] = new JsonObject { ["code"] = code, ["message"] = message } };

    /// <summary>
    /// Vault servi par un autre pair que le pair gere : 503, avec { mode, url }
    /// pour que le client sache ou aller (ou qu'il n'y a rien a demander).
    /// </summary>
    public static IndexerReply NotManaged(VaultIndexerSetting setting, int retryAfterSeconds)
    {
        bool organization = setting.Mode == IndexerMode.Organization;
        JsonObject body = ErrorJson(IndexerErrorCodes.Unavailable,
            organization
                ? "Ce vault est servi par le pair indexeur de son organisation."
                : "Ce vault n'a pas de pair indexeur.");
        body["mode"] = setting.Mode.ToApiString();
        if (organization && setting.Url is not null) body["url"] = setting.Url;
        // Pas de Retry-After pour un pair d'organisation : reessayer ici ne sert a rien.
        return new IndexerReply(503, body.ToJsonString(), organization ? null : retryAfterSeconds);
    }
}

/// <summary>Codes d'erreur du protocole (docs/Architecture/indexer-protocol.md).</summary>
public static class IndexerErrorCodes
{
    public const string InvalidQuery       = "invalid_query";
    public const string InvalidCursor      = "invalid_cursor";
    public const string TooComplex         = "too_complex";
    public const string UnknownCapability  = "unknown_capability";
    public const string UnknownMethod      = "unknown_method";
    public const string NotOwner           = "not_owner";
    public const string Overloaded         = "overloaded";
    public const string Unavailable        = "unavailable";
    /// <summary>Limite de debit du backend (par personne ou par vault).</summary>
    public const string RateLimited        = "rate_limited";
    /// <summary>Corps de requete plus grand que Indexer:MaxBodyBytes.</summary>
    public const string PayloadTooLarge    = "payload_too_large";
    /// <summary>API interne : instance absente de Indexer:Instances.</summary>
    public const string UnknownInstance    = "unknown_instance";
}
