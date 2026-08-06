// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// S2 pour K_User -- voir GetVaultKeyQueryHandler.cs pour le detail du tag.
using MediatR;
using Microsoft.AspNetCore.Mvc;
using Savoire.Application.Users.GetVaultKey;

namespace Savoire.Server.Controllers;

public class VaultKeyController(IMediator mediator) : AppControllerBase(mediator)
{
    [HttpGet("api/v1/vault-key")]
    public async Task<IActionResult> GetKey(CancellationToken ct)
    {
        var result = await Mediator.Send(new GetVaultKeyQuery(GetCallerId()), ct);
        return Ok(result);
    }
}
