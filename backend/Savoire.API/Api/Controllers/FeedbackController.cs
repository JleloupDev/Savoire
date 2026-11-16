// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// FeedbackController — les retours des testeurs (bulle de l'application).
// Routes :
//   POST   /api/v1/feedback                          compte connecte : { message, context?, screenshot? (data URL) }
//   GET    /api/v1/admin/feedback?archived=false     administrateur : la liste, sans les captures
//   GET    /api/v1/admin/feedback/{id}/screenshot    administrateur : la capture
//   POST   /api/v1/admin/feedback/{id}/archive       administrateur : { archived }
//   DELETE /api/v1/admin/feedback/{id}               administrateur
using System.Text.Json;
using FluentValidation;
using FluentValidation.Results;
using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Savoire.Application.Feedback;
using Savoire.Server.Extensions;

namespace Savoire.Server.Controllers;

public sealed record SubmitFeedbackRequest(string? Message, JsonElement? Context, string? Screenshot);
public sealed record ArchiveFeedbackRequest(bool Archived);

public class FeedbackController(IMediator mediator) : AppControllerBase(mediator)
{
    /// <summary>Capture en base64 (4 Mio) et le reste : large.</summary>
    private const int MaxRequestBytes = 6 * 1024 * 1024;

    [HttpPost("api/v1/feedback")]
    [RateLimited(RatePolicies.Upload)]
    [RequestSizeLimit(MaxRequestBytes)]
    public async Task<IActionResult> Submit([FromBody] SubmitFeedbackRequest req, CancellationToken ct)
    {
        string? context = req.Context is { ValueKind: JsonValueKind.Object } c ? c.GetRawText() : null;
        string id = await Mediator.Send(new SubmitFeedbackCommand(
            GetCallerId(), req.Message ?? "", context, DecodeScreenshot(req.Screenshot), Request.Headers.UserAgent.ToString()), ct);
        return Ok(new { id });
    }

    [HttpGet("api/v1/admin/feedback")]
    [Authorize(Policy = "AdminOnly")]
    public async Task<IActionResult> List([FromQuery] bool archived = false, CancellationToken ct = default) =>
        Ok(await Mediator.Send(new ListFeedbackQuery(archived), ct));

    [HttpGet("api/v1/admin/feedback/{id}/screenshot")]
    [Authorize(Policy = "AdminOnly")]
    public async Task<IActionResult> Screenshot(string id, CancellationToken ct)
    {
        if (await Mediator.Send(new GetFeedbackScreenshotQuery(id), ct) is not { } shot) return NotFound();
        Response.Headers.CacheControl = "private, no-store";
        return File(shot.Bytes, shot.Type);
    }

    [HttpPost("api/v1/admin/feedback/{id}/archive")]
    [Authorize(Policy = "AdminOnly")]
    public async Task<IActionResult> Archive(string id, [FromBody] ArchiveFeedbackRequest req, CancellationToken ct) =>
        await Mediator.Send(new ArchiveFeedbackCommand(id, req.Archived), ct) ? NoContent() : NotFound();

    [HttpDelete("api/v1/admin/feedback/{id}")]
    [Authorize(Policy = "AdminOnly")]
    public async Task<IActionResult> Delete(string id, CancellationToken ct) =>
        await Mediator.Send(new DeleteFeedbackCommand(id), ct) ? NoContent() : NotFound();

    /// <summary>« data:image/...;base64,... » ou base64 nu ; vide : pas de capture.</summary>
    private static byte[]? DecodeScreenshot(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        int comma = value.StartsWith("data:", StringComparison.Ordinal) ? value.IndexOf(',') : -1;
        try { return Convert.FromBase64String(comma >= 0 ? value[(comma + 1)..] : value); }
        catch (FormatException)
        {
            throw new ValidationException([new ValidationFailure("screenshot", "Capture illisible.")]);
        }
    }
}
