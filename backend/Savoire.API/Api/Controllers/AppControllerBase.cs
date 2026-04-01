// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Classe de base des controllers — Clean Architecture MediatR.
// DECISION V2: GetCallerId() lit le claim Sub du JWT (plus de X-User-Id).

using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Savoire.Server.Extensions;

namespace Savoire.Server.Controllers;

[ApiController]
[Authorize]
public abstract class AppControllerBase(IMediator mediator) : ControllerBase
{
    protected IMediator Mediator { get; } = mediator;

    /// <summary>Lit l'userId depuis le claim Sub du JWT.</summary>
    protected string GetCallerId() => HttpContext.GetUserId();
}
