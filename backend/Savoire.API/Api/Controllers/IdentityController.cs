// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Microsoft.AspNetCore.Mvc;
using Savoire.Application.Users.GetIdentityKey;

namespace Savoire.Server.Controllers;

public class IdentityController(IMediator mediator) : AppControllerBase(mediator)
{
    [HttpGet("api/v1/identity/key")]
    public async Task<IActionResult> GetKey(CancellationToken ct)
    {
        var result = await Mediator.Send(new GetIdentityKeyQuery(GetCallerId()), ct);
        return Ok(result);
    }
}
