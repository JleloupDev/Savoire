// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Users controller — GET /api/v1/users, GET /api/v1/users/{userId}
// DECISION V2: [AllowAnonymous] kept — these read endpoints remain public.

using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Savoire.Application.Common;
using Savoire.Application.Users.GetAllUsers;

namespace Savoire.Server.Controllers;

[AllowAnonymous]
public class UsersController(IMediator mediator) : AppControllerBase(mediator)
{
    [HttpGet("api/v1/users")]
    public async Task<IActionResult> GetAll(CancellationToken ct)
        => Ok(await Mediator.Send(new GetAllUsersQuery(), ct));

    [HttpGet("api/v1/users/{userId}")]
    public async Task<IActionResult> GetById(string userId, CancellationToken ct)
    {
        IReadOnlyList<UserDto> all = await Mediator.Send(new GetAllUsersQuery(), ct);
        UserDto? user = all.FirstOrDefault(u => string.Equals(u.Id, userId, StringComparison.OrdinalIgnoreCase));
        return user is null ? NotFound() : Ok(user);
    }
}
