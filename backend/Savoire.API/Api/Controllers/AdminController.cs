// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Savoire.Application.Admin.Commands;
using Savoire.Application.Admin.DTOs;
using Savoire.Application.Admin.Queries;
using Savoire.Application.Auth.DTOs;

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

    /// <summary>Create a user directly</summary>
    [HttpPost("users")]
    [ProducesResponseType(typeof(AuthUserDto), 201)]
    [ProducesResponseType(typeof(ProblemDetails), 400)]
    public async Task<IActionResult> CreateUser(CreateUserRequest request)
    {
        var result = await mediator.Send(new CreateUserCommand(
            request.Email,
            request.Password,
            request.DisplayName,
            request.IsAdmin));
        return Created(string.Empty, result);
    }

    /// <summary>Reset a user's password</summary>
    [HttpPost("users/{userId}/reset-password")]
    [ProducesResponseType(204)]
    [ProducesResponseType(typeof(ProblemDetails), 404)]
    public async Task<IActionResult> ResetPassword(
        string userId, ResetPasswordRequest request)
    {
        await mediator.Send(new ResetPasswordCommand(userId, request.NewPassword));
        return NoContent();
    }

    [HttpPost("users/{userId}/revoke-sessions")]
    public async Task<IActionResult> RevokeSessions(string userId)
    {
        await mediator.Send(new RevokeUserSessionsCommand(userId));
        return NoContent();
    }

    [HttpPost("users/{userId}/disable")]
    public async Task<IActionResult> DisableUser(string userId)
    {
        await mediator.Send(new DisableUserCommand(userId));
        return NoContent();
    }
}
