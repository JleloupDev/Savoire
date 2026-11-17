// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Droits herites et surcharges (voir AclResolver).
//
//   GET    /api/v1/vaults/{vaultId}/acl?docId=...|folder=...      droits d'un niveau (+ herites)
//   PUT    /api/v1/vaults/{vaultId}/acl/inherit                   { docId|folder, inherit }
//   PUT    /api/v1/vaults/{vaultId}/acl/entries                   { docId|folder, subjectId, permission, expiresAt? }
//   DELETE /api/v1/vaults/{vaultId}/acl/entries?docId|folder&subjectId=...
//   POST   /api/v1/vaults/{vaultId}/acl/folders/rename            { from, to }
//   PUT    /api/v1/vaults/{vaultId}/documents/folders             [{ docId, folder }]  (annonce du client)
// permission : read, write, admin, none (aucun acces).

using MediatR;
using Microsoft.AspNetCore.Mvc;
using Savoire.Application.Sharing.Acl;

namespace Savoire.Server.Controllers;

public sealed record AclInheritRequest(string? DocId, string? Folder, bool Inherit);
public sealed record AclEntryRequest(string? DocId, string? Folder, string SubjectId, string Permission, DateTime? ExpiresAt);
public sealed record AclFolderRenameRequest(string From, string To);

public class AclController(IMediator mediator) : AppControllerBase(mediator)
{
    [HttpGet("api/v1/vaults/{vaultId}/acl")]
    public async Task<IActionResult> Get(string vaultId, [FromQuery] string? docId, [FromQuery] string? folder, CancellationToken ct)
        => Ok(await Mediator.Send(new GetAclQuery(GetCallerId(), new AclTarget(vaultId, docId, folder)), ct));

    [HttpPut("api/v1/vaults/{vaultId}/acl/inherit")]
    public async Task<IActionResult> SetInherit(string vaultId, [FromBody] AclInheritRequest req, CancellationToken ct)
    {
        await Mediator.Send(new SetAclInheritCommand(GetCallerId(), new AclTarget(vaultId, req.DocId, req.Folder), req.Inherit), ct);
        return NoContent();
    }

    [HttpPut("api/v1/vaults/{vaultId}/acl/entries")]
    public async Task<IActionResult> SetEntry(string vaultId, [FromBody] AclEntryRequest req, CancellationToken ct)
    {
        await Mediator.Send(new SetAclEntryCommand(GetCallerId(), new AclTarget(vaultId, req.DocId, req.Folder), req.SubjectId, req.Permission, req.ExpiresAt), ct);
        return NoContent();
    }

    [HttpDelete("api/v1/vaults/{vaultId}/acl/entries")]
    public async Task<IActionResult> RemoveEntry(string vaultId, [FromQuery] string? docId, [FromQuery] string? folder, [FromQuery] string subjectId, CancellationToken ct)
    {
        await Mediator.Send(new RemoveAclEntryCommand(GetCallerId(), new AclTarget(vaultId, docId, folder), subjectId), ct);
        return NoContent();
    }

    [HttpPost("api/v1/vaults/{vaultId}/acl/folders/rename")]
    public async Task<IActionResult> RenameFolder(string vaultId, [FromBody] AclFolderRenameRequest req, CancellationToken ct)
    {
        await Mediator.Send(new RenameAclFolderCommand(GetCallerId(), vaultId, req.From, req.To), ct);
        return NoContent();
    }

    [HttpPut("api/v1/vaults/{vaultId}/documents/folders")]
    public async Task<IActionResult> PlaceDocuments(string vaultId, [FromBody] List<DocumentFolderDto> documents, CancellationToken ct)
        => Ok(new { rejected = await Mediator.Send(new PlaceDocumentsCommand(GetCallerId(), vaultId, documents), ct) });
}
