// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Routes : /api/v1/vaults/{vaultId}/documents/...

using MediatR;
using Microsoft.AspNetCore.Mvc;
using Savoire.Application.Common;
using Savoire.Application.Documents.GetDocumentContent;
using Savoire.Application.Documents.ListDocuments;
using Savoire.Application.Documents.PutDocumentContent;

namespace Savoire.Server.Controllers;

public class DocumentsController(IMediator mediator) : AppControllerBase(mediator)
{
    // GET /api/v1/vaults/{vaultId}/documents[?folder=...&includeDeleted=true]
    [HttpGet("api/v1/vaults/{vaultId}/documents")]
    public async Task<IActionResult> List(
        string vaultId,
        [FromQuery] string? folder,
        [FromQuery] bool includeDeleted = false,
        CancellationToken ct = default)
        => Ok(await Mediator.Send(
            new ListDocumentsQuery(GetCallerId(), vaultId, folder, includeDeleted), ct));

    // GET /api/v1/vaults/{vaultId}/documents/{docId}/content
    [HttpGet("api/v1/vaults/{vaultId}/documents/{docId}/content")]
    public async Task<IActionResult> GetContent(string vaultId, string docId, CancellationToken ct)
    {
        Stream stream = await Mediator.Send(
            new GetDocumentContentQuery(GetCallerId(), vaultId, docId), ct);
        return File(stream, "text/markdown; charset=utf-8");
    }

    // PUT /api/v1/vaults/{vaultId}/documents/{docId}/content
    [HttpPut("api/v1/vaults/{vaultId}/documents/{docId}/content")]
    public async Task<IActionResult> PutContent(
        string vaultId, string docId, CancellationToken ct)
    {
        using var reader = new StreamReader(Request.Body);
        string body = await reader.ReadToEndAsync(ct);
        return Ok(await Mediator.Send(
            new PutDocumentContentCommand(GetCallerId(), vaultId, docId, body), ct));
    }
}
