// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Domain.Interfaces;

namespace Savoire.Application.Auth.Commands;

public record LogoutCommand(string RefreshToken) : IRequest;

public class LogoutCommandHandler(
    ITokenService tokenService) : IRequestHandler<LogoutCommand>
{
    public async Task Handle(LogoutCommand request, CancellationToken ct)
        => await tokenService.RevokeRefreshTokenAsync(request.RefreshToken);
}
