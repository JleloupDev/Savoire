// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// La connexion se fait chez le fournisseur d'identite (ADR-028) : ici, seulement
// de quoi le trouver (config) et le compte Savoire de la personne connectee (me).
using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Savoire.Application.Auth.DTOs;
using Savoire.Application.Auth.Queries;
using Savoire.Server.Extensions;

namespace Savoire.Server.Controllers;

[ApiController]
[Route("api/v1/auth")]
public class AuthController(IMediator mediator) : ControllerBase
{
    [HttpGet("config")]
    [AllowAnonymous]
    [ProducesResponseType(typeof(AuthConfigDto), 200)]
    [ProducesResponseType(typeof(ProblemDetails), 503)]
    public async Task<IActionResult> Config(CancellationToken ct) =>
        await mediator.Send(new GetAuthConfigQuery(), ct) is { } config
            ? Ok(config)
            : Problem(statusCode: 503, title: "Connexion non configuree",
                detail: "Auth:Oidc (fournisseur d'identite) manque sur ce serveur.");

    /// <summary>Le compte de la personne connectee (cree a sa premiere connexion).</summary>
    [HttpGet("me")]
    [Authorize]
    [ProducesResponseType(typeof(AuthUserDto), 200)]
    public async Task<IActionResult> Me(CancellationToken ct) =>
        await mediator.Send(new GetCurrentUserQuery(HttpContext.GetUserId()), ct) is { } user
            ? Ok(user)
            : Unauthorized();

    /// <summary>Ce que le compte occupe sur le serveur (ses vaults) et son quota de stockage.</summary>
    [HttpGet("me/usage")]
    [Authorize]
    public async Task<IActionResult> Usage(CancellationToken ct) =>
        Ok(await mediator.Send(new Savoire.Application.Admin.Queries.GetAccountUsageQuery(HttpContext.GetUserId()), ct));

    public sealed record DeleteMyAccountRequest(string? Confirm);

    /// <summary>Mot a renvoyer pour confirmer la suppression de son compte.</summary>
    public const string DeleteConfirmation = "SUPPRIMER";

    /// <summary>
    /// Supprime le compte de la personne connectee, ses vaults et tout leur
    /// contenu, ici et chez le fournisseur d'identite. Irreversible : le
    /// corps doit porter { "confirm": "SUPPRIMER" }.
    /// </summary>
    [HttpDelete("me")]
    [Authorize]
    public async Task<IActionResult> DeleteMe([FromBody] DeleteMyAccountRequest? body, CancellationToken ct)
    {
        if (body?.Confirm != DeleteConfirmation)
            return Problem(statusCode: 400, title: "Confirmation manquante",
                detail: $"Envoyer {{ \"confirm\": \"{DeleteConfirmation}\" }} pour supprimer le compte.");
        await mediator.Send(new Savoire.Application.Admin.Commands.DeleteAccountCommand(HttpContext.GetUserId()), ct);
        return NoContent();
    }
}
