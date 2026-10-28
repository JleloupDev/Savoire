// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Relais vers le pair indexeur : corps envoyes au pair, et traduction de ses
// reponses en reponses publiques (docs/Architecture/indexer-protocol.md).
//
// Le client ne voit jamais une erreur interne du pair : les erreurs listees
// par le protocole (400, 404, 429, 503) passent telles quelles ; le reste
// (injoignable, delai depasse, 401 d'un jeton mal configure, 500...) devient
// 503 « unavailable » avec Retry-After, et le client bascule sur son index.

using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;
using Savoire.Application.Abstractions;
using Savoire.Domain.Enums;
using Savoire.Domain.ReadModels;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Indexer;

public static class IndexerRelay
{
    private static readonly JsonDocumentOptions ParseOptions = new() { MaxDepth = 64 };

    /// <summary>Corps de POST /v1/vaults/{id}/call. caller vient du jeton, jamais du client.</summary>
    public static byte[] CallBody(string capability, string method, string paramsJson, string callerId)
    {
        using var buffer = new MemoryStream();
        using (var w = new Utf8JsonWriter(buffer))
        {
            w.WriteStartObject();
            w.WriteString("capability", capability);
            w.WriteString("method", method);
            w.WritePropertyName("params");
            w.WriteRawValue(paramsJson, skipInputValidation: false);
            w.WriteStartObject("caller");
            w.WriteString("userId", callerId);
            w.WriteEndObject();
            w.WriteEndObject();
        }
        return buffer.ToArray();
    }

    /// <summary>
    /// Le vault peut-il etre relaye au pair gere ? Rend la reponse de refus
    /// (503) sinon : pair non configure, vault en mode none ou organization.
    /// </summary>
    public static async Task<IndexerReply?> CheckManagedAsync(
        IndexerOptions opts, IVaultIndexerSettingRepository settings, string vaultId, CancellationToken ct)
    {
        if (!opts.Enabled || opts.Instances.Count == 0)
            return IndexerReply.Unavailable("Aucun pair indexeur n'est configure sur ce serveur.", opts.RetryAfterSeconds);
        VaultIndexerSetting setting = await settings.GetAsync(vaultId, ct);
        return setting.Mode == IndexerMode.Managed ? null : IndexerReply.NotManaged(setting, opts.RetryAfterSeconds);
    }

    /// <summary>Le pair dit ne pas posseder le vault (409 not_owner) : le routage est a recalculer.</summary>
    public static bool IsNotOwner(IndexerPeerResponse response) =>
        response.Outcome == IndexerPeerOutcome.Answered
        && response.StatusCode == 409
        && ErrorCode(response.Body) == IndexerErrorCodes.NotOwner;

    /// <summary>
    /// Reponse publique pour une reponse du pair. <paramref name="resultOnly"/> :
    /// la reponse publique est le champ « result » du pair (appel de pouvoir).
    /// </summary>
    public static IndexerReply ToReply(IndexerPeerResponse response, IndexerOptions opts, bool resultOnly, ILogger logger)
    {
        switch (response.Outcome)
        {
            case IndexerPeerOutcome.Unreachable:
                return IndexerReply.Unavailable("Le pair indexeur est injoignable.", opts.RetryAfterSeconds);
            case IndexerPeerOutcome.TimedOut:
                return IndexerReply.Unavailable("Le pair indexeur n'a pas repondu a temps.", opts.RetryAfterSeconds);
            case IndexerPeerOutcome.TooLarge:
                logger.LogWarning("Pair indexeur : reponse plus grande que {Max} octets", opts.MaxResponseBytes);
                return IndexerReply.Unavailable("Reponse du pair indexeur trop grande.", opts.RetryAfterSeconds);
        }

        if (response.IsSuccess)
        {
            if (!resultOnly) return IsJson(response.Body) ? IndexerReply.Ok(response.Body!) : Malformed(opts, logger);
            string? result = ResultOf(response.Body);
            return result is null ? Malformed(opts, logger) : IndexerReply.Ok(result);
        }

        int retryAfter = response.RetryAfter is { } ra ? Math.Max(1, (int)Math.Ceiling(ra.TotalSeconds)) : opts.RetryAfterSeconds;
        switch (response.StatusCode)
        {
            case 400:
            case 404:
                return PassThrough(response, null);
            case 429:
            case 503:
                return PassThrough(response, retryAfter);
            case 401:
            case 403:
                logger.LogError("Pair indexeur : jeton de service refuse ({Status}). Verifier Indexer:ServiceToken et SAVOIRE_INDEXER_TOKEN.", response.StatusCode);
                return IndexerReply.Unavailable("Le pair indexeur est indisponible.", opts.RetryAfterSeconds);
            case 409:
                return IndexerReply.Unavailable("Le routage du pair indexeur change, reessayer.", retryAfter);
            default:
                logger.LogWarning("Pair indexeur : statut inattendu {Status}", response.StatusCode);
                return IndexerReply.Unavailable("Le pair indexeur est indisponible.", opts.RetryAfterSeconds);
        }
    }

    /// <summary>Erreur du pair rendue telle quelle, mais reecrite : seuls code et message passent.</summary>
    private static IndexerReply PassThrough(IndexerPeerResponse response, int? retryAfter)
    {
        (string? code, string? message) = ErrorOf(response.Body);
        string fallback = response.StatusCode switch
        {
            404 => IndexerErrorCodes.UnknownCapability,
            429 => IndexerErrorCodes.Overloaded,
            503 => IndexerErrorCodes.Unavailable,
            _   => IndexerErrorCodes.InvalidQuery,
        };
        return IndexerReply.Error(response.StatusCode, code ?? fallback, message ?? "", retryAfter);
    }

    private static IndexerReply Malformed(IndexerOptions opts, ILogger logger)
    {
        logger.LogWarning("Pair indexeur : reponse illisible");
        return IndexerReply.Unavailable("Reponse du pair indexeur illisible.", opts.RetryAfterSeconds);
    }

    public static string? ErrorCode(string? body) => ErrorOf(body).Code;

    private static (string? Code, string? Message) ErrorOf(string? body)
    {
        if (body is null) return (null, null);
        try
        {
            using JsonDocument doc = JsonDocument.Parse(body, ParseOptions);
            if (doc.RootElement.ValueKind == JsonValueKind.Object
                && doc.RootElement.TryGetProperty("error", out JsonElement error)
                && error.ValueKind == JsonValueKind.Object)
            {
                string? code = error.TryGetProperty("code", out JsonElement c) && c.ValueKind == JsonValueKind.String ? c.GetString() : null;
                string? message = error.TryGetProperty("message", out JsonElement m) && m.ValueKind == JsonValueKind.String ? m.GetString() : null;
                return (code, message);
            }
        }
        catch (JsonException) { }
        return (null, null);
    }

    private static string? ResultOf(string? body)
    {
        if (body is null) return null;
        try
        {
            using JsonDocument doc = JsonDocument.Parse(body, ParseOptions);
            if (doc.RootElement.ValueKind == JsonValueKind.Object
                && doc.RootElement.TryGetProperty("result", out JsonElement result))
                return result.GetRawText();
        }
        catch (JsonException) { }
        return null;
    }

    private static bool IsJson(string? body)
    {
        if (body is null) return false;
        try { using JsonDocument _ = JsonDocument.Parse(body, ParseOptions); return true; }
        catch (JsonException) { return false; }
    }

    /// <summary>Objet JSON lu dans une reponse du pair, ou null.</summary>
    public static JsonObject? ParseObject(string? body)
    {
        if (body is null) return null;
        try { return JsonNode.Parse(body, documentOptions: ParseOptions) as JsonObject; }
        catch (JsonException) { return null; }
    }

    public static byte[] Utf8(JsonNode node) => Encoding.UTF8.GetBytes(node.ToJsonString());
}
