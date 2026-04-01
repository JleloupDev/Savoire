// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Controller synchronisation — délègue à MediatR.
// Routes : /api/v1/vaults/{vaultId}/sync/...

using MediatR;
using Microsoft.AspNetCore.Mvc;
using Savoire.Application.Common;
using Savoire.Application.Sync.GetSyncStatus;
using Savoire.Application.Sync.PushOps;
using Savoire.Application.Sync.SyncDocument;

namespace Savoire.Server.Controllers;

public class SyncController(IMediator mediator) : AppControllerBase(mediator)
{
    // GET /api/v1/vaults/{vaultId}/sync/status?since=...
    [HttpGet("api/v1/vaults/{vaultId}/sync/status")]
    public async Task<IActionResult> GetStatus(
        string vaultId, [FromQuery] DateTime since, CancellationToken ct)
        => Ok(await Mediator.Send(new GetSyncStatusQuery(GetCallerId(), vaultId, since), ct));

    // POST /api/v1/vaults/{vaultId}/documents/{docId}/sync
    [HttpPost("api/v1/vaults/{vaultId}/documents/{docId}/sync")]
    public async Task<IActionResult> SyncDocument(
        string vaultId, string docId, [FromBody] SyncRequestDto req, CancellationToken ct)
        => Ok(await Mediator.Send(new SyncDocumentCommand(GetCallerId(), vaultId, docId, req), ct));

    // POST /api/v1/vaults/{vaultId}/documents/{docId}/operations
    [HttpPost("api/v1/vaults/{vaultId}/documents/{docId}/operations")]
    public async Task<IActionResult> PushOps(
        string vaultId, string docId, [FromBody] PushOpsRequestDto req, CancellationToken ct)
    {
        await Mediator.Send(new PushOpsCommand(GetCallerId(), vaultId, docId, req), ct);
        return NoContent();
    }
}
