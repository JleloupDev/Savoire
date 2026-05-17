// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Microsoft.AspNetCore.Identity;
using Savoire.Application.Auth.DTOs;
using Savoire.Application.Auth.Mappers;
using Savoire.Domain.Entities;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Interfaces;

namespace Savoire.Application.Auth.Commands;

public sealed record LoginCommand(string Email, string Password, string ClientIp)
    : IRequest<AuthResponse>;

public sealed class LoginCommandHandler(
    UserManager<AppUser> userManager,
    SignInManager<AppUser> signInManager,
    ITokenService tokenService) : IRequestHandler<LoginCommand, AuthResponse>
{
    public async Task<AuthResponse> Handle(LoginCommand request, CancellationToken ct)
    {
        var user = await userManager.FindByEmailAsync(request.Email)
            ?? throw new InvalidCredentialsException();

        var result = await signInManager.CheckPasswordSignInAsync(
            user, request.Password, lockoutOnFailure: true);

        if (result.IsLockedOut)
            throw new AccountLockedException();

        if (!result.Succeeded)
            throw new InvalidCredentialsException();

        user.LastLoginAt = DateTime.UtcNow;
        await userManager.UpdateAsync(user);

        var accessToken = tokenService.GenerateAccessToken(user);
        var refreshToken = await tokenService.GenerateRefreshTokenAsync(user, request.ClientIp);

        return new AuthResponse(
            AccessToken: accessToken,
            RefreshToken: refreshToken.Token,
            ExpiresIn: 15 * 60,
            User: UserMapper.ToDto(user)
        );
    }
}
