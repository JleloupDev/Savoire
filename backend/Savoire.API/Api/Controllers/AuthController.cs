// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Savoire.Application.Auth.Commands;
using Savoire.Application.Auth.DTOs;
using Savoire.Server.Extensions;

namespace Savoire.Server.Controllers;

[ApiController]
[Route("api/v1/auth")]
public class AuthController(IMediator mediator) : ControllerBase
{
    [HttpPost("login")]
    [AllowAnonymous]
    [ProducesResponseType(typeof(AuthResponse), 200)]
    [ProducesResponseType(typeof(ProblemDetails), 401)]
    public async Task<IActionResult> Login(LoginRequest request) =>
        Ok(await mediator.Send(new LoginCommand(
            request.Email, request.Password, GetClientIp())));

    [HttpPost("refresh")]
    [AllowAnonymous]
    [ProducesResponseType(typeof(AuthResponse), 200)]
    [ProducesResponseType(typeof(ProblemDetails), 401)]
    public async Task<IActionResult> Refresh(RefreshRequest request) =>
        Ok(await mediator.Send(new RefreshTokenCommand(
            request.RefreshToken, GetClientIp())));

    [HttpPost("logout")]
    [Authorize]
    public async Task<IActionResult> Logout(LogoutRequest request)
    {
        await mediator.Send(new LogoutCommand(request.RefreshToken));
        return NoContent();
    }

    [HttpPost("change-password")]
    [Authorize]
    public async Task<IActionResult> ChangePassword(ChangePasswordRequest request)
    {
        await mediator.Send(new ChangePasswordCommand(
            HttpContext.GetUserId(), request.CurrentPassword, request.NewPassword));
        return NoContent();
    }

    private string GetClientIp() =>
        HttpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
}
