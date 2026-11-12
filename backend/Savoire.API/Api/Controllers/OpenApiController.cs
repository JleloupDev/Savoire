// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// OpenApiController — l'API ouverte, par jeton personnel (Bearer svp_...).
// Lecture seule. Decrite dans openapi.yaml (balise « Open API »), ce qui
// suffit aux « Actions » d'un GPT, a n8n ou a Zapier.
//   GET  /api/open/v1/openapi.yaml                  (sans jeton) la description OpenAPI
//   GET  /api/open/v1/vaults
//   POST /api/open/v1/vaults/{vaultId}/search       { text, limit?, folder? }
//   GET  /api/open/v1/vaults/{vaultId}/notes        ?folder=&limit=&cursor=
//   GET  /api/open/v1/vaults/{vaultId}/notes/read   ?path=  ou  ?id=
//   POST /api/open/v1/vaults/{vaultId}/query        (requete du pair indexeur, docs/Architecture/indexer-protocol.md)
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Savoire.Application.Indexer;
using Savoire.Infrastructure.Auth;
using Savoire.Server.Extensions;
using Savoire.Server.Open;

namespace Savoire.Server.Controllers;

public sealed record OpenSearchRequest(string? Text, int? Limit, string? Folder);

[ApiController]
[Authorize(AuthenticationSchemes = AccessTokenAuthenticationHandler.Scheme)]
[IndexerRateLimited]
[Route("api/open/v1")]
public class OpenApiController(IMediator mediator) : ControllerBase
{
    private readonly OpenGateway gateway = new(mediator);

    private const int MaxQueryBytes = 64 * 1024;

    private OpenCaller Caller => OpenCaller.From(User);

    /// <summary>La description OpenAPI de l'API ouverte, adresse du serveur comprise (Actions d'un GPT).</summary>
    [AllowAnonymous]
    [HttpGet("openapi.yaml")]
    public async Task<IActionResult> Description(CancellationToken ct)
    {
        string path = Path.Combine(AppContext.BaseDirectory, "open-api.yaml");
        if (!System.IO.File.Exists(path)) return NotFound();
        string yaml = await System.IO.File.ReadAllTextAsync(path, ct);
        string server = $"{Request.Scheme}://{Request.Host}{Request.PathBase}";
        return Content(yaml.Replace("{{SERVER}}", server), "application/yaml; charset=utf-8");
    }

    [HttpGet("vaults")]
    public async Task<IActionResult> Vaults(CancellationToken ct)
        => Ok(new { vaults = await gateway.VaultsAsync(Caller, ct) });

    [HttpPost("vaults/{vaultId}/search")]
    public async Task<IActionResult> Search(string vaultId, [FromBody] OpenSearchRequest req, CancellationToken ct)
        => Reply(await gateway.SearchAsync(Caller, vaultId, req.Text ?? "", req.Limit, req.Folder, ct));

    [HttpGet("vaults/{vaultId}/notes")]
    public async Task<IActionResult> Notes(string vaultId, [FromQuery] string? folder, [FromQuery] int? limit, [FromQuery] string? cursor, CancellationToken ct)
        => Reply(await gateway.ListNotesAsync(Caller, vaultId, folder, limit, cursor, ct));

    [HttpGet("vaults/{vaultId}/notes/read")]
    public async Task<IActionResult> Read(string vaultId, [FromQuery] string? path, [FromQuery] string? id, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(path) && string.IsNullOrEmpty(id))
            return Reply(IndexerReply.Error(400, IndexerErrorCodes.InvalidQuery, "Donner path ou id."));
        return Reply(await gateway.ReadAsync(Caller, vaultId, id, path, ct));
    }

    [HttpPost("vaults/{vaultId}/query")]
    [RequestSizeLimit(MaxQueryBytes)]
    public async Task<IActionResult> Query(string vaultId, [FromBody] JsonElement body, CancellationToken ct)
    {
        if (body.ValueKind != JsonValueKind.Object)
            return Reply(IndexerReply.Error(400, IndexerErrorCodes.InvalidQuery, "Objet JSON attendu."));
        return Reply(await gateway.CallAsync(Caller, vaultId, "query", "run", JsonNode.Parse(body.GetRawText())!, ct));
    }

    private ContentResult Reply(IndexerReply reply)
    {
        if (reply.RetryAfterSeconds is int seconds)
            Response.Headers.RetryAfter = seconds.ToString(CultureInfo.InvariantCulture);
        return new ContentResult { StatusCode = reply.StatusCode, Content = reply.Json, ContentType = "application/json; charset=utf-8" };
    }
}
