// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Interfaces;

namespace Savoire.Application.Admin.Commands;

public record RevokeUserSessionsCommand(string UserId) : IRequest;

public class RevokeUserSessionsCommandHandler(
    ITokenService tokenService,
    IUserService userService) : IRequestHandler<RevokeUserSessionsCommand>
{
    public async Task Handle(RevokeUserSessionsCommand request, CancellationToken ct)
    {
        if (!await userService.ExistsAsync(request.UserId, ct))
            throw new UserNotFoundException(request.UserId);

        await tokenService.RevokeAllUserRefreshTokensAsync(request.UserId);
    }
}
