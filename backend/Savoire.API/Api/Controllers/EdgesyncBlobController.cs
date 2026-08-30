// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Edgesync blob store — blind, per-vault backup of the P2P protocol's
// encrypted state (see edgesync-protocol's IStorage port). Opaque to the
// server, same "opaque to the server" stance as index snapshots (ADR-022).
// Routes: /api/v1/vaults/{vaultId}/edgesync-blobs/{*key}

using MediatR;
using Microsoft.AspNetCore.Mvc;
using Savoire.Application.Common;
using Savoire.Application.Sync.EdgesyncBlob;

namespace Savoire.Server.Controllers;

[Route("api/v1/vaults/{vaultId}/edgesync-blobs")]
public class EdgesyncBlobController(IMediator mediator) : AppControllerBase(mediator)
{
    // GET /api/v1/vaults/{vaultId}/edgesync-blobs/{*key}
    [HttpGet("{*key}")]
    public async Task<IActionResult> Get(string vaultId, string key, CancellationToken ct)
    {
        byte[]? bytes = await Mediator.Send(new FetchEdgesyncBlobQuery(vaultId, key, GetCallerId()), ct);
        if (bytes is null) return NotFound();
        return Ok(new EdgesyncBlobDto(Convert.ToBase64String(bytes)));
    }

    // PUT /api/v1/vaults/{vaultId}/edgesync-blobs/{*key}
    [HttpPut("{*key}")]
    public async Task<IActionResult> Put(
        string vaultId, string key,
        [FromBody] EdgesyncBlobDto req,
        CancellationToken ct)
    {
        byte[] bytes = Convert.FromBase64String(req.BytesBase64);
        await Mediator.Send(new PersistEdgesyncBlobCommand(vaultId, key, bytes, GetCallerId()), ct);
        return NoContent();
    }
}
