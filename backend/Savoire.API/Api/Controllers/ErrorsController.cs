// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Suivi des erreurs de l'appli (voir Extensions/ErrorEnvelope.cs) :
//  - GET  /api/v1/errors/config   : ou envoyer les rapports (vide : nulle part) ;
//  - POST /api/v1/errors/envelope : un rapport, relaye a GlitchTip.
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Savoire.Server.Extensions;

namespace Savoire.Server.Controllers;

[ApiController]
[Route("api/v1/errors")]
[AllowAnonymous]
public class ErrorsController(IConfiguration config, IHttpClientFactory http, ILogger<ErrorsController> logger) : ControllerBase
{
    /// <summary>Taille maximale d'un rapport (une pile d'appels, pas des fichiers).</summary>
    private const int MaxEnvelopeBytes = 256 * 1024;

    public record ErrorReportingConfig(string? Dsn, string? Environment, string? Release);

    [HttpGet("config")]
    public ErrorReportingConfig Config()
    {
        string? dsn = config["ErrorReporting:ClientDsn"];
        bool on = ErrorEnvelope.ParseDsn(dsn) is not null && !string.IsNullOrWhiteSpace(config["ErrorReporting:Upstream"]);
        return new ErrorReportingConfig(on ? dsn : null, config["ErrorReporting:Environment"], config["ErrorReporting:Release"]);
    }

    [HttpPost("envelope")]
    [RequestSizeLimit(MaxEnvelopeBytes)]
    public async Task<IActionResult> Envelope(CancellationToken ct)
    {
        string? upstream = config["ErrorReporting:Upstream"];
        if (string.IsNullOrWhiteSpace(upstream)) return NotFound();

        using var buffer = new MemoryStream();
        await Request.Body.CopyToAsync(buffer, ct);
        byte[] body = buffer.ToArray();
        if (ErrorEnvelope.Route(body, config["ErrorReporting:ClientDsn"]) is not { } target) return BadRequest();

        using var request = new HttpRequestMessage(HttpMethod.Post,
            $"{upstream.TrimEnd('/')}/api/{target.ProjectId}/envelope/")
        {
            Content = new ByteArrayContent(body),
        };
        request.Content.Headers.TryAddWithoutValidation("Content-Type", "application/x-sentry-envelope");
        request.Headers.TryAddWithoutValidation("X-Sentry-Auth",
            $"Sentry sentry_version=7, sentry_key={target.Key}, sentry_client=savoire-tunnel/1");
        try
        {
            using HttpResponseMessage response = await http.CreateClient("errors").SendAsync(request, ct);
            return StatusCode((int)response.StatusCode);
        }
        catch (HttpRequestException err)
        {
            // GlitchTip arrete : l'appli ne doit pas en souffrir.
            logger.LogWarning("Rapport d'erreur non relaye : {Message}", err.Message);
            return StatusCode(StatusCodes.Status503ServiceUnavailable);
        }
    }
}
