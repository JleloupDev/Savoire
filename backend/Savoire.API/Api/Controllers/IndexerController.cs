// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Routes publiques du pair indexeur (ADR-027,
// docs/Architecture/indexer-protocol.md, « Routes publiques ») :
//   POST /api/v1/vaults/{vaultId}/index/{capability}/{method}
//   POST /api/v1/search
//   GET  /api/v1/vaults/{vaultId}/indexer
//   PUT  /api/v1/vaults/{vaultId}/indexer
//
// Compte connecte obligatoire, droit de lecture sur le vault
// (VaultAccessBehavior), jamais par un lien de partage. Debit limite par
// personne et par vault (IndexerSetup). Corps borne a Indexer:MaxBodyBytes.
// Les erreurs du relais ont la forme du protocole : { error: { code, message } }.

using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using MediatR;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;
using Savoire.Application.Indexer;
using Savoire.Application.Indexer.CallIndexer;
using Savoire.Application.Indexer.SearchAllVaults;
using Savoire.Application.Indexer.VaultIndexer;
using Savoire.Server.Extensions;
using Savoire.Server.Models.Dto;

namespace Savoire.Server.Controllers;

[IndexerRateLimited]
public partial class IndexerController(IMediator mediator, IOptionsMonitor<IndexerOptions> options)
    : AppControllerBase(mediator)
{
    /// <summary>Nom d'un pouvoir ou d'une methode : minuscules, chiffres, « _ » et « - ».</summary>
    [GeneratedRegex(@"^[a-z][a-z0-9_-]{0,63}$")]
    private static partial Regex NameRegex();

    private static readonly JsonDocumentOptions ParseOptions = new() { MaxDepth = 64 };

    // POST /api/v1/vaults/{vaultId}/index/{capability}/{method}
    [HttpPost("api/v1/vaults/{vaultId}/index/{capability}/{method}")]
    public async Task<IActionResult> Call(string vaultId, string capability, string method, CancellationToken ct)
    {
        if (!NameRegex().IsMatch(capability) || !NameRegex().IsMatch(method))
            return Reply(IndexerReply.Error(400, IndexerErrorCodes.InvalidQuery, "Nom de pouvoir ou de methode invalide."));
        (string? json, IndexerReply? refused) = await ReadJsonBodyAsync(emptyAs: "{}", ct);
        if (refused is not null) return Reply(refused);
        return Reply(await Mediator.Send(new CallIndexerQuery(GetCallerId(), vaultId, capability, method, json!), ct));
    }

    // POST /api/v1/search
    [HttpPost("api/v1/search")]
    public async Task<IActionResult> Search(CancellationToken ct)
    {
        (string? json, IndexerReply? refused) = await ReadJsonBodyAsync(emptyAs: null, ct);
        if (refused is not null) return Reply(refused);
        return Reply(await Mediator.Send(new SearchAllVaultsQuery(GetCallerId(), json!), ct));
    }

    // GET /api/v1/vaults/{vaultId}/indexer
    [HttpGet("api/v1/vaults/{vaultId}/indexer")]
    public async Task<IActionResult> GetSetting(string vaultId, CancellationToken ct)
        => Ok(await Mediator.Send(new GetVaultIndexerQuery(GetCallerId(), vaultId), ct));

    // PUT /api/v1/vaults/{vaultId}/indexer
    [HttpPut("api/v1/vaults/{vaultId}/indexer")]
    public async Task<IActionResult> SetSetting(string vaultId, [FromBody] VaultIndexerRequest body, CancellationToken ct)
        => Ok(await Mediator.Send(new SetVaultIndexerCommand(GetCallerId(), vaultId, body.Mode ?? "", body.Url), ct));

    private ContentResult Reply(IndexerReply reply)
    {
        if (reply.RetryAfterSeconds is int seconds)
            Response.Headers.RetryAfter = seconds.ToString(CultureInfo.InvariantCulture);
        return new ContentResult
        {
            StatusCode  = reply.StatusCode,
            Content     = reply.Json,
            ContentType = "application/json; charset=utf-8",
        };
    }

    /// <summary>
    /// Lit le corps, borne a Indexer:MaxBodyBytes (413 au-dela), et verifie
    /// que c'est du JSON (400 sinon). Corps vide : <paramref name="emptyAs"/>
    /// (null : refuse).
    /// </summary>
    private async Task<(string? Json, IndexerReply? Refused)> ReadJsonBodyAsync(string? emptyAs, CancellationToken ct)
    {
        int max = options.CurrentValue.MaxBodyBytes;
        IndexerReply tooLarge = IndexerReply.Error(StatusCodes.Status413PayloadTooLarge,
            IndexerErrorCodes.PayloadTooLarge, $"Corps limite a {max} octets.");
        if (Request.ContentLength > max) return (null, tooLarge);

        using var buffer = new MemoryStream();
        byte[] chunk = new byte[8 * 1024];
        int read;
        while ((read = await Request.Body.ReadAsync(chunk, ct)) > 0)
        {
            if (buffer.Length + read > max) return (null, tooLarge);
            buffer.Write(chunk, 0, read);
        }

        string text = Encoding.UTF8.GetString(buffer.GetBuffer(), 0, (int)buffer.Length);
        if (string.IsNullOrWhiteSpace(text))
            return emptyAs is null
                ? (null, IndexerReply.Error(400, IndexerErrorCodes.InvalidQuery, "Corps JSON attendu."))
                : (emptyAs, null);
        try
        {
            using JsonDocument _ = JsonDocument.Parse(text, ParseOptions);
            return (text, null);
        }
        catch (JsonException)
        {
            return (null, IndexerReply.Error(400, IndexerErrorCodes.InvalidQuery, "Corps JSON invalide."));
        }
    }
}
