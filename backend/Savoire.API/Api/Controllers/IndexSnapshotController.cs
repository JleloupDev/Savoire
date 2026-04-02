// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Index snapshots controller — server-side persistence of plugin index states.
// Routes : /api/v1/vaults/{vaultId}/index-snapshots/{namespace}
// see ADR-022

using MediatR;
using Microsoft.AspNetCore.Mvc;
using Savoire.Application.Common;
using Savoire.Application.Metadata.IndexSnapshot;

namespace Savoire.Server.Controllers;

public class IndexSnapshotController(IMediator mediator) : AppControllerBase(mediator)
{
    // GET /api/v1/vaults/{vaultId}/index-snapshots/{namespace}
    [HttpGet("api/v1/vaults/{vaultId}/index-snapshots/{namespace}")]
    public async Task<IActionResult> Get(string vaultId, string @namespace, CancellationToken ct)
    {
        var dto = await Mediator.Send(new GetIndexSnapshotQuery(vaultId, @namespace, GetCallerId()), ct);
        if (dto is null) return NotFound();
        return Ok(dto);
    }

    // PUT /api/v1/vaults/{vaultId}/index-snapshots/{namespace}
    [HttpPut("api/v1/vaults/{vaultId}/index-snapshots/{namespace}")]
    public async Task<IActionResult> Save(
        string vaultId, string @namespace,
        [FromBody] SaveIndexSnapshotRequest req,
        CancellationToken ct)
    {
        await Mediator.Send(new SaveIndexSnapshotCommand(
            vaultId, @namespace, req.ProcessedSeq, req.Data, GetCallerId()), ct);
        return NoContent();
    }
}
