// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Auth.DTOs;
using Savoire.Application.Auth.Mappers;
using Savoire.Domain.Interfaces;

namespace Savoire.Application.Auth.Commands;

public sealed record RefreshTokenCommand(string RefreshToken, string ClientIp)
    : IRequest<AuthResponse>;

public sealed class RefreshTokenCommandHandler(
    ITokenService tokenService) : IRequestHandler<RefreshTokenCommand, AuthResponse>
{
    public async Task<AuthResponse> Handle(RefreshTokenCommand request, CancellationToken ct)
    {
        var (user, newToken) = await tokenService.RotateRefreshTokenAsync(
            request.RefreshToken, request.ClientIp);

        return new AuthResponse(
            AccessToken: tokenService.GenerateAccessToken(user),
            RefreshToken: newToken.Token,
            ExpiresIn: 15 * 60,
            User: UserMapper.ToDto(user)
        );
    }
}
