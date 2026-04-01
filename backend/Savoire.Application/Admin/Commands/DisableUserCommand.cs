// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Microsoft.AspNetCore.Identity;
using Savoire.Domain.Entities;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Interfaces;

namespace Savoire.Application.Admin.Commands;

public record DisableUserCommand(string UserId) : IRequest;

public class DisableUserCommandHandler(
    UserManager<AppUser> userManager,
    ITokenService tokenService) : IRequestHandler<DisableUserCommand>
{
    public async Task Handle(DisableUserCommand request, CancellationToken ct)
    {
        var user = await userManager.FindByIdAsync(request.UserId)
            ?? throw new UserNotFoundException(request.UserId);

        await userManager.SetLockoutEnabledAsync(user, true);
        await userManager.SetLockoutEndDateAsync(user, DateTimeOffset.MaxValue);
        await tokenService.RevokeAllUserRefreshTokensAsync(request.UserId);
    }
}
