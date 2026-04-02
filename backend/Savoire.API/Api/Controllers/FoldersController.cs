// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Routes : /api/v1/vaults/{vaultId}/folders/...

using MediatR;
using Microsoft.AspNetCore.Mvc;
using Savoire.Application.Common;
using Savoire.Application.Folders.CreateFolder;
using Savoire.Application.Folders.DeleteFolder;
using Savoire.Application.Folders.ListFolders;
using Savoire.Application.Folders.RenameFolder;

namespace Savoire.Server.Controllers;

public class FoldersController(IMediator mediator) : AppControllerBase(mediator)
{
    // GET /api/v1/vaults/{vaultId}/folders
    [HttpGet("api/v1/vaults/{vaultId}/folders")]
    public async Task<IActionResult> List(string vaultId, CancellationToken ct)
        => Ok(await Mediator.Send(new ListFoldersQuery(GetCallerId(), vaultId), ct));

    // POST /api/v1/vaults/{vaultId}/folders
    [HttpPost("api/v1/vaults/{vaultId}/folders")]
    public async Task<IActionResult> Create(
        string vaultId, [FromBody] CreateFolderRequest req, CancellationToken ct)
    {
        FolderDto dto = await Mediator.Send(
            new CreateFolderCommand(GetCallerId(), vaultId, req.Path), ct);
        return StatusCode(201, dto);
    }

    // PATCH /api/v1/vaults/{vaultId}/folders/{folderId}
    [HttpPatch("api/v1/vaults/{vaultId}/folders/{folderId}")]
    public async Task<IActionResult> Rename(
        string vaultId, string folderId, [FromBody] PatchFolderRequest req, CancellationToken ct)
        => Ok(await Mediator.Send(
            new RenameFolderCommand(GetCallerId(), vaultId, folderId, req.Path), ct));

    // DELETE /api/v1/vaults/{vaultId}/folders/{folderId}[?force=true]
    [HttpDelete("api/v1/vaults/{vaultId}/folders/{folderId}")]
    public async Task<IActionResult> Delete(
        string vaultId, string folderId, [FromQuery] bool force = false, CancellationToken ct = default)
    {
        await Mediator.Send(new DeleteFolderCommand(GetCallerId(), vaultId, folderId, force), ct);
        return NoContent();
    }
}
