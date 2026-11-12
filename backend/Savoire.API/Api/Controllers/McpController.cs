// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// McpController — le serveur MCP de Savoire (Open/McpServer.cs).
//   POST /api/mcp   un message JSON-RPC, une reponse JSON (ou 202 pour une notification)
//   GET  /api/mcp   405 : pas de flux SSE
// Jeton personnel : Authorization: Bearer svp_...
using System.Text.Json;
using System.Text.Json.Nodes;
using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Savoire.Infrastructure.Auth;
using Savoire.Server.Extensions;
using Savoire.Server.Open;

namespace Savoire.Server.Controllers;

[ApiController]
[Authorize(AuthenticationSchemes = AccessTokenAuthenticationHandler.Scheme)]
[IndexerRateLimited]
[Route("api/mcp")]
public class McpController(IMediator mediator, ILogger<McpServer> logger) : ControllerBase
{
    private readonly McpServer server = new(new OpenGateway(mediator), logger);

    private const int MaxBytes = 256 * 1024;

    [HttpPost]
    [RequestSizeLimit(MaxBytes)]
    public async Task<IActionResult> Post(CancellationToken ct)
    {
        JsonNode? message;
        try
        {
            message = await JsonNode.ParseAsync(Request.Body, documentOptions: new JsonDocumentOptions { MaxDepth = 32 }, cancellationToken: ct);
        }
        catch (JsonException)
        {
            return Json(McpServer.Error(null, -32700, "JSON invalide."));
        }
        JsonObject? reply = await server.HandleAsync(message, OpenCaller.From(User), ct);
        return reply is null ? Accepted() : Json(reply);
    }

    [HttpGet]
    public IActionResult Stream() => StatusCode(405);

    [HttpDelete]
    public IActionResult EndSession() => StatusCode(405);

    private ContentResult Json(JsonObject body) =>
        new() { StatusCode = 200, Content = body.ToJsonString(), ContentType = "application/json; charset=utf-8" };
}
