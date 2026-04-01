// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Microsoft.AspNetCore.Identity;
using Savoire.Domain.Entities;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Interfaces;

namespace Savoire.Application.Admin.Commands;

public record ResetPasswordCommand(
    string UserId,
    string NewPassword) : IRequest;

public class ResetPasswordCommandHandler(
    UserManager<AppUser> userManager,
    ITokenService tokenService) : IRequestHandler<ResetPasswordCommand>
{
    public async Task Handle(ResetPasswordCommand request, CancellationToken ct)
    {
        var user = await userManager.FindByIdAsync(request.UserId)
            ?? throw new UserNotFoundException(request.UserId);

        // Générer un token de reset interne et l'appliquer immédiatement
        var resetToken = await userManager.GeneratePasswordResetTokenAsync(user);
        var result = await userManager.ResetPasswordAsync(
            user, resetToken, request.NewPassword);

        if (!result.Succeeded)
            throw new IdentityOperationException(result.Errors);

        // Révoquer toutes les sessions — l'utilisateur doit se reconnecter
        await tokenService.RevokeAllUserRefreshTokensAsync(request.UserId);
    }
}
