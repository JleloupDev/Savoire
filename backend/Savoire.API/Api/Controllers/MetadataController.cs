// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Controller métadonnées — délègue à MediatR.
// Routes : /api/v1/vaults/{vaultId}/metadata/...

using MediatR;
using Microsoft.AspNetCore.Mvc;
using Savoire.Application.Metadata.GetBacklinks;
using Savoire.Application.Metadata.GetDocumentMeta;
using Savoire.Application.Metadata.GetTags;
using Savoire.Application.Metadata.IndexDocumentContent;
using Savoire.Application.Metadata.GetVaultLinks;
using Savoire.Application.Metadata.ListAllMeta;

namespace Savoire.Server.Controllers;

public class MetadataController(IMediator mediator) : AppControllerBase(mediator)
{
    // GET /api/v1/vaults/{vaultId}/documents/{docId}/meta
    [HttpGet("api/v1/vaults/{vaultId}/documents/{docId}/meta")]
    public async Task<IActionResult> GetMeta(string vaultId, string docId, CancellationToken ct)
        => Ok(await Mediator.Send(new GetDocumentMetaQuery(vaultId, docId, GetCallerId()), ct));

    // GET /api/v1/vaults/{vaultId}/backlinks/{docId}
    [HttpGet("api/v1/vaults/{vaultId}/backlinks/{docId}")]
    public async Task<IActionResult> GetBacklinks(string vaultId, string docId, CancellationToken ct)
        => Ok(await Mediator.Send(new GetBacklinksQuery(vaultId, docId, GetCallerId()), ct));

    // GET /api/v1/vaults/{vaultId}/tags
    [HttpGet("api/v1/vaults/{vaultId}/tags")]
    public async Task<IActionResult> GetTags(string vaultId, CancellationToken ct)
        => Ok(await Mediator.Send(new GetTagsQuery(vaultId, GetCallerId()), ct));

    /// <summary>
    /// GET /api/v1/vaults/{vaultId}/metadata
    /// Retourne toutes les métadonnées indexées du vault — endpoint d'audit/debug.
    /// ?includeDerived=false pour exclure les shadow documents.
    /// </summary>
    [HttpGet("api/v1/vaults/{vaultId}/metadata")]
    public async Task<IActionResult> ListAllMeta(
        string vaultId,
        [FromQuery] bool includeDerived = true,
        CancellationToken ct = default)
        => Ok(await Mediator.Send(new ListAllMetaQuery(vaultId, GetCallerId(), includeDerived), ct));

    // GET /api/v1/vaults/{vaultId}/links
    // Retourne tous les liens du vault avec les paths source résolus — pour initialiser le graphe client au chargement du vault.
    [HttpGet("api/v1/vaults/{vaultId}/links")]
    public async Task<IActionResult> GetVaultLinks(string vaultId, CancellationToken ct)
        => Ok(await Mediator.Send(new GetVaultLinksQuery(vaultId, GetCallerId()), ct));

    // POST /api/v1/vaults/{vaultId}/documents/{docId}/index
    [HttpPost("api/v1/vaults/{vaultId}/documents/{docId}/index")]
    public async Task<IActionResult> IndexContent(
        string vaultId, string docId,
        [FromBody] IndexContentRequest req,
        CancellationToken ct)
    {
        await Mediator.Send(new IndexDocumentContentCommand(
            docId, vaultId, req.MarkdownContent,
            req.DerivedFrom, req.DerivedBy, req.ContentType), ct);
        return NoContent();
    }
}

public record IndexContentRequest(
    string  MarkdownContent,
    string? DerivedFrom  = null,
    string? DerivedBy    = null,
    string? ContentType  = null
);
