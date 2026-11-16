// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// GET /api/v1/store/config : ou trouver le Savoire Store, et la cle publique
// qui verifie ses paquets (Store:Url, Store:PublicKey ; deploy/compose/
// docker-compose.store.yml). La cle vient du serveur Savoire, pas du store :
// un store compromis ne peut pas la remplacer. Sans compte : l'application la
// lit avant meme de connaitre la personne.

using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Savoire.Server.Controllers;

[ApiController]
[AllowAnonymous]
public class StoreConfigController(IMediator mediator, IConfiguration config) : ControllerBase
{
    public sealed record StoreConfigDto(string? Url, string? PublicKey);

    [HttpGet("api/v1/store/config")]
    public StoreConfigDto Get()
    {
        _ = mediator;
        string? url = config["Store:Url"];
        string? key = config["Store:PublicKey"];
        return new StoreConfigDto(string.IsNullOrWhiteSpace(url) ? null : url, string.IsNullOrWhiteSpace(key) ? null : key);
    }
}
