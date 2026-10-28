// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// API interne lue par le pair indexeur (ADR-027,
// docs/Architecture/indexer-protocol.md, « API interne »). Lecture seule.
//
// Pas de compte utilisateur : le jeton de service (IndexerServiceToken)
// remplace l'authentification habituelle. Sans jeton configure, ces routes
// n'existent pas (404). Le pair n'est jamais expose : ces routes ne devraient
// etre joignables que depuis le reseau prive.

using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;
using Savoire.Application.Indexer;
using Savoire.Application.Indexer.Internal;
using Savoire.Server.Middleware;

namespace Savoire.Server.Controllers;

[AllowAnonymous]
[IndexerServiceToken]
[ApiExplorerSettings(IgnoreApi = true)]
[Route("internal/indexer")]
public class InternalIndexerController(IMediator mediator, IOptionsMonitor<IndexerOptions> options)
    : AppControllerBase(mediator)
{
    // GET /internal/indexer/vaults?instance={name}
    [HttpGet("vaults")]
    public async Task<IActionResult> Vaults([FromQuery] string? instance, CancellationToken ct)
    {
        if (UnknownInstance(instance) is { } refused) return refused;
        return Ok(await Mediator.Send(new ListIndexerVaultsQuery(instance!), ct));
    }

    // GET /internal/indexer/changes?instance={name}&since={seq}&limit={n}
    [HttpGet("changes")]
    public async Task<IActionResult> Changes(
        [FromQuery] string? instance, [FromQuery] long since = 0, [FromQuery] int? limit = null, CancellationToken ct = default)
    {
        if (UnknownInstance(instance) is { } refused) return refused;
        if (since < 0) return Error(400, IndexerErrorCodes.InvalidCursor, "since : entier positif ou nul.");
        return Ok(await Mediator.Send(new GetIndexerChangesQuery(instance!, since, limit), ct));
    }

    // GET /internal/indexer/vaults/{vaultId}/tree
    [HttpGet("vaults/{vaultId}/tree")]
    public async Task<IActionResult> Tree(string vaultId, CancellationToken ct) =>
        await Mediator.Send(new GetIndexerTreeQuery(vaultId), ct) is { } updates
            ? Ok(updates)
            : Error(404, "not_found", "Vault inconnu ou non servi par le pair gere.");

    // GET /internal/indexer/vaults/{vaultId}/documents/{docId}
    [HttpGet("vaults/{vaultId}/documents/{docId}")]
    public async Task<IActionResult> Document(string vaultId, string docId, CancellationToken ct) =>
        await Mediator.Send(new GetIndexerDocumentQuery(vaultId, docId), ct) is { } updates
            ? Ok(updates)
            : Error(404, "not_found", "Document inconnu dans ce vault.");

    private IActionResult? UnknownInstance(string? instance)
    {
        if (string.IsNullOrWhiteSpace(instance))
            return Error(400, IndexerErrorCodes.UnknownInstance, "Parametre instance obligatoire.");
        return options.CurrentValue.FindInstance(instance) is null
            ? Error(400, IndexerErrorCodes.UnknownInstance, $"Instance « {instance} » absente de Indexer:Instances.")
            : null;
    }

    private static ContentResult Error(int status, string code, string message) => new()
    {
        StatusCode  = status,
        Content     = IndexerReply.ErrorJson(code, message).ToJsonString(),
        ContentType = "application/json; charset=utf-8",
    };
}
