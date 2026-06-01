// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Routes : /api/v1/vaults/{vaultId}/documents/...

using MediatR;
using Microsoft.AspNetCore.Mvc;
using Savoire.Application.Documents.GetDocumentContent;
using Savoire.Application.Documents.PutDocumentContent;

namespace Savoire.Server.Controllers;

public class DocumentsController(IMediator mediator) : AppControllerBase(mediator)
{
    [HttpGet("api/v1/vaults/{vaultId}/documents/{docId}/content")]
    public async Task<IActionResult> GetContent(string vaultId, string docId, CancellationToken ct)
    {
        Stream stream = await Mediator.Send(
            new GetDocumentContentQuery(GetCallerId(), vaultId, docId), ct);
        return File(stream, "text/markdown; charset=utf-8");
    }

    [HttpPut("api/v1/vaults/{vaultId}/documents/{docId}/content")]
    public async Task<IActionResult> PutContent(
        string vaultId, string docId, CancellationToken ct)
    {
        using var reader = new StreamReader(Request.Body);
        string body = await reader.ReadToEndAsync(ct);
        await Mediator.Send(new PutDocumentContentCommand(GetCallerId(), vaultId, docId, body), ct);
        return NoContent();
    }
}
