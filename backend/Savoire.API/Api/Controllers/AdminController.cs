// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Savoire.Application.Admin.Commands;
using Savoire.Application.Admin.DTOs;
using Savoire.Application.Admin.Queries;

namespace Savoire.Server.Controllers;

[ApiController]
[Authorize(Policy = "AdminOnly")]
[Route("api/v1/admin")]
public class AdminController(IMediator mediator) : ControllerBase
{
    [HttpGet("users")]
    [ProducesResponseType(typeof(AdminUserDto[]), 200)]
    public async Task<IActionResult> ListUsers() =>
        Ok(await mediator.Send(new ListUsersQuery()));

    /// <summary>
    /// Bloque un compte dans Savoire : ses jetons sont refuses, meme valides
    /// chez le fournisseur d'identite.
    /// </summary>
    [HttpPost("users/{userId}/disable")]
    public async Task<IActionResult> DisableUser(string userId)
    {
        await mediator.Send(new DisableUserCommand(userId));
        return NoContent();
    }

    /// <summary>
    /// Supprime un compte, ses vaults et tout leur contenu, ici et chez le
    /// fournisseur d'identite (demande d'effacement). Irreversible.
    /// </summary>
    [HttpDelete("users/{userId}")]
    public async Task<IActionResult> DeleteUser(string userId, CancellationToken ct)
    {
        await mediator.Send(new DeleteAccountCommand(userId), ct);
        return NoContent();
    }

    /// <summary>
    /// Restes de vaults supprimes (lignes et fichiers sans vault). Par defaut
    /// on compte seulement ; dryRun=false efface.
    /// </summary>
    [HttpPost("orphans/purge")]
    public async Task<IActionResult> PurgeOrphans([FromQuery] bool dryRun = true, CancellationToken ct = default) =>
        Ok(await mediator.Send(new PurgeOrphansCommand(dryRun), ct));
}
