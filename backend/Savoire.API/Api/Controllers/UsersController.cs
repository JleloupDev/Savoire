// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Comptes — GET /api/v1/users?email=..., GET /api/v1/users/{userId}
//
// Un compte connecte retrouve UN autre compte, par son adresse exacte (pour
// l'inviter) ou par son identifiant : son nom, rien d'autre. Il n'existe pas
// de liste des comptes. Avant le 15/11/2026 ces routes etaient publiques :
// n'importe qui lisait le nom de tous les comptes, et savait si une adresse
// en avait un (revue du 14/11/2026, E1).
//
// Un lien de partage ou un jeton de vue n'y a pas acces. Le debit est borne
// par compte : sans cela, un compte testerait des adresses a la chaine.

using MediatR;
using Microsoft.AspNetCore.Mvc;
using Savoire.Application.Common;
using Savoire.Application.Sharing;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Services;
using Savoire.Server.Extensions;

namespace Savoire.Server.Controllers;

[RateLimited(RatePolicies.Lookup)]
public class UsersController(IMediator mediator, IUserLookupService users) : AppControllerBase(mediator)
{
    [HttpGet("api/v1/users")]
    public async Task<IActionResult> GetByEmail([FromQuery] string? email, CancellationToken ct)
    {
        RequireAccount();
        if (string.IsNullOrWhiteSpace(email) || email.Length > 320)
            return BadRequest("Adresse attendue : /api/v1/users?email=...");
        UserInfo? user = await users.GetByEmailAsync(email.Trim(), ct);
        return user is null ? NotFound() : Ok(UserDto.FromDomain(user));
    }

    [HttpGet("api/v1/users/{userId}")]
    public async Task<IActionResult> GetById(string userId, CancellationToken ct)
    {
        RequireAccount();
        UserInfo? user = await users.GetByIdAsync(userId, ct);
        return user is null ? NotFound() : Ok(UserDto.FromDomain(user));
    }

    private void RequireAccount()
    {
        string callerId = GetCallerId();
        if (ShareLinkGuard.IsShareLinkCaller(callerId) || ShareLinkGuard.IsViewCaller(callerId))
            throw new AccessDeniedException("Un lien de partage ne donne pas acces aux comptes.");
    }
}
