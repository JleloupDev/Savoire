// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// AccessTokensController — les jetons personnels de l'API ouverte.
// Routes (compte connecte, jamais par un jeton personnel) :
//   GET    /api/v1/me/access-tokens
//   POST   /api/v1/me/access-tokens        { name, vaultIds?, expiresInDays? }  -> le jeton, une fois
//   DELETE /api/v1/me/access-tokens/{id}
using MediatR;
using Microsoft.AspNetCore.Mvc;
using Savoire.Application.AccessTokens;

namespace Savoire.Server.Controllers;

public sealed record CreateAccessTokenRequest(string? Name, List<string>? VaultIds, int? ExpiresInDays);

public class AccessTokensController(IMediator mediator) : AppControllerBase(mediator)
{
    [HttpGet("api/v1/me/access-tokens")]
    public async Task<IActionResult> List(CancellationToken ct)
        => Ok(await Mediator.Send(new ListAccessTokensQuery(GetCallerId()), ct));

    [HttpPost("api/v1/me/access-tokens")]
    public async Task<IActionResult> Create([FromBody] CreateAccessTokenRequest req, CancellationToken ct)
        => Ok(await Mediator.Send(new CreateAccessTokenCommand(GetCallerId(), req.Name ?? "", req.VaultIds, req.ExpiresInDays), ct));

    [HttpDelete("api/v1/me/access-tokens/{id}")]
    public async Task<IActionResult> Revoke(string id, CancellationToken ct)
    {
        await Mediator.Send(new RevokeAccessTokenCommand(GetCallerId(), id), ct);
        return NoContent();
    }
}
