// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// PublicationsController — publier une note sur le web.
// Routes :
//   GET    /api/v1/vaults/{vaultId}/documents/{docId}/publication
//   PUT    /api/v1/vaults/{vaultId}/documents/{docId}/publication   { title, description, html, indexable }
//   DELETE /api/v1/vaults/{vaultId}/documents/{docId}/publication
//   GET    /p/{slug}                                                 [AllowAnonymous] page HTML
using System.Net;
using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Savoire.Application.Publications;
using Savoire.Domain.ReadModels;
using Savoire.Server.Publications;

namespace Savoire.Server.Controllers;

public sealed record PublishRequest(string Title, string Description, string Html, bool Indexable);

public class PublicationsController(IMediator mediator) : AppControllerBase(mediator)
{
    [HttpGet("api/v1/vaults/{vaultId}/documents/{docId}/publication")]
    public async Task<IActionResult> Get(string vaultId, string docId, CancellationToken ct)
    {
        PublicationDto? dto = await Mediator.Send(new GetPublicationQuery(vaultId, docId, GetCallerId()), ct);
        return dto is null ? NoContent() : Ok(dto);
    }

    [HttpPut("api/v1/vaults/{vaultId}/documents/{docId}/publication")]
    [RequestSizeLimit(32 * 1024 * 1024)]
    public async Task<IActionResult> Publish(string vaultId, string docId, [FromBody] PublishRequest req, CancellationToken ct)
        => Ok(await Mediator.Send(new PublishDocumentCommand(vaultId, docId, GetCallerId(), req.Title ?? "", req.Description ?? "", req.Html ?? "", req.Indexable), ct));

    [HttpDelete("api/v1/vaults/{vaultId}/documents/{docId}/publication")]
    public async Task<IActionResult> Unpublish(string vaultId, string docId, CancellationToken ct)
    {
        await Mediator.Send(new UnpublishDocumentCommand(vaultId, docId, GetCallerId()), ct);
        return NoContent();
    }

    /// <summary>
    /// La page publique. Le HTML vient de l'application d'un editeur : il est
    /// servi sous une politique qui interdit tout script et toute connexion,
    /// dans un bac a sable. Rien ne peut s'y executer, quoi qu'il contienne.
    /// </summary>
    [AllowAnonymous]
    [HttpGet("p/{slug}")]
    public async Task<IActionResult> Page(string slug, CancellationToken ct)
    {
        Publication? p = await Mediator.Send(new GetPublicPageQuery(slug), ct);
        Response.Headers["Content-Security-Policy"] =
            "default-src 'none'; img-src data: https:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src data: https://fonts.gstatic.com; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; sandbox allow-popups allow-popups-to-escape-sandbox";
        Response.Headers["X-Content-Type-Options"] = "nosniff";
        Response.Headers["Referrer-Policy"] = "no-referrer";
        if (p is null)
        {
            Response.Headers["X-Robots-Tag"] = "noindex";
            return new ContentResult { StatusCode = 404, ContentType = "text/html; charset=utf-8", Content = PublicPage.NotFound() };
        }
        if (!p.Indexable) Response.Headers["X-Robots-Tag"] = "noindex, nofollow";
        Response.Headers["Cache-Control"] = "public, max-age=30";
        Response.Headers["Last-Modified"] = p.UpdatedAt.ToString("R");
        string url = $"{Request.Scheme}://{Request.Host}{Request.PathBase}/p/{p.Slug}";
        return new ContentResult { StatusCode = 200, ContentType = "text/html; charset=utf-8", Content = PublicPage.Render(p, url) };
    }
}
