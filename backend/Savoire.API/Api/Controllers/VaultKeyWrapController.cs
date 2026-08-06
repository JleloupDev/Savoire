// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Vault key escrow — blind, per-user backup of a vault's Keyring, wrapped
// client-side under the account's own K_User. Opaque to the server (S3):
// unrelated to EdgesyncBlobController, which persists vault *content*.
// Routes: /api/v1/vaults/{vaultId}/key-wrap

using MediatR;
using Microsoft.AspNetCore.Mvc;
using Savoire.Application.Common;
using Savoire.Application.Sync.VaultKeyWrap;

namespace Savoire.Server.Controllers;

[Route("api/v1/vaults/{vaultId}/key-wrap")]
public class VaultKeyWrapController(IMediator mediator) : AppControllerBase(mediator)
{
    // GET /api/v1/vaults/{vaultId}/key-wrap
    [HttpGet]
    public async Task<IActionResult> Get(string vaultId, CancellationToken ct)
    {
        byte[]? bytes = await Mediator.Send(new FetchVaultKeyWrapQuery(vaultId, GetCallerId()), ct);
        if (bytes is null) return NotFound();
        return Ok(new EdgesyncBlobDto(Convert.ToBase64String(bytes)));
    }

    // PUT /api/v1/vaults/{vaultId}/key-wrap
    [HttpPut]
    public async Task<IActionResult> Put(
        string vaultId,
        [FromBody] EdgesyncBlobDto req,
        CancellationToken ct)
    {
        byte[] bytes = Convert.FromBase64String(req.BytesBase64);
        await Mediator.Send(new PersistVaultKeyWrapCommand(vaultId, bytes, GetCallerId()), ct);
        return NoContent();
    }
}
