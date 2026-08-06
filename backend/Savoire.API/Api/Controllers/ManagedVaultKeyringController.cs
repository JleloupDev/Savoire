// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Managed vault keyring — S2 for a vault (as opposed to VaultKeyWrapController's
// S3, per-account via K_User): the server holds the Keyring in clear for a
// vault created as "Managed". Decided once at creation (Vault.IsManaged),
// never converted afterwards here. See ManagedVaultKeyringSource.ts.
// Routes: /api/v1/vaults/{vaultId}/managed-keyring

using MediatR;
using Microsoft.AspNetCore.Mvc;
using Savoire.Application.Common;
using Savoire.Application.Sync.ManagedVaultKeyring;

namespace Savoire.Server.Controllers;

[Route("api/v1/vaults/{vaultId}/managed-keyring")]
public class ManagedVaultKeyringController(IMediator mediator) : AppControllerBase(mediator)
{
    // GET /api/v1/vaults/{vaultId}/managed-keyring
    [HttpGet]
    public async Task<IActionResult> Get(string vaultId, CancellationToken ct)
    {
        byte[]? bytes = await Mediator.Send(new FetchManagedVaultKeyringQuery(vaultId, GetCallerId()), ct);
        if (bytes is null) return NotFound();
        return Ok(new EdgesyncBlobDto(Convert.ToBase64String(bytes)));
    }

    // PUT /api/v1/vaults/{vaultId}/managed-keyring
    [HttpPut]
    public async Task<IActionResult> Put(
        string vaultId,
        [FromBody] EdgesyncBlobDto req,
        CancellationToken ct)
    {
        byte[] bytes = Convert.FromBase64String(req.BytesBase64);
        await Mediator.Send(new PersistManagedVaultKeyringCommand(vaultId, bytes, GetCallerId()), ct);
        return NoContent();
    }
}
