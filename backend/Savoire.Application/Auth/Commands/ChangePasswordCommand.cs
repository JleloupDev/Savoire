// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Microsoft.AspNetCore.Identity;
using Savoire.Domain.Entities;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Interfaces;

namespace Savoire.Application.Auth.Commands;

public sealed record ChangePasswordCommand(
    string UserId,
    string CurrentPassword,
    string NewPassword) : IRequest;

public sealed class ChangePasswordCommandHandler(
    UserManager<AppUser> userManager,
    ITokenService tokenService) : IRequestHandler<ChangePasswordCommand>
{
    public async Task Handle(ChangePasswordCommand request, CancellationToken ct)
    {
        var user = await userManager.FindByIdAsync(request.UserId)
            ?? throw new UserNotFoundException(request.UserId);

        var result = await userManager.ChangePasswordAsync(
            user, request.CurrentPassword, request.NewPassword);

        if (!result.Succeeded)
            throw new IdentityOperationException(result.Errors);

        await tokenService.RevokeAllUserRefreshTokensAsync(request.UserId);
    }
}
