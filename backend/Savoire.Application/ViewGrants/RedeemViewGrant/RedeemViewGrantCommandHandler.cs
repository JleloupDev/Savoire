// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Microsoft.Extensions.Logging;
using Microsoft.IdentityModel.Tokens;
using Savoire.Application.Common;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Interfaces;

namespace Savoire.Application.ViewGrants.RedeemViewGrant;

public class RedeemViewGrantCommandHandler(ITokenService tokenService, ILogger<RedeemViewGrantCommandHandler> logger)
    : IRequestHandler<RedeemViewGrantCommand, ViewAccessDto>
{
    public Task<ViewAccessDto> Handle(RedeemViewGrantCommand cmd, CancellationToken ct)
    {
        logger.LogInformation(
            "RedeemViewGrant start tokenLen={TokenLen} tokenPrefix={TokenPrefix}",
            cmd.GrantToken?.Length ?? 0,
            MaskPrefix(cmd.GrantToken));
        ViewGrantPayload payload;
        try
        {
            payload = tokenService.ReadViewGrantToken(cmd.GrantToken);
        }
        catch (SecurityTokenExpiredException ex)
        {
            logger.LogWarning("RedeemViewGrant: grant token expired. {Message}", ex.Message);
            throw new AccessDeniedException("View grant expiré.");
        }
        catch (SecurityTokenException ex)
        {
            logger.LogWarning("RedeemViewGrant: invalid grant token. {Message}", ex.Message);
            throw new AccessDeniedException("View grant invalide.");
        }
        string accessToken = tokenService.GenerateViewAccessToken(payload);
        DateTime accessExpiresAt = DateTime.UtcNow.AddHours(8);
        logger.LogInformation("RedeemViewGrant success doc={DocId} permission={Permission}", payload.DocId, payload.Permission);

        return Task.FromResult(new ViewAccessDto(
            accessToken,
            payload.VaultId,
            payload.DocId,
            payload.Path,
            payload.Permission,
            accessExpiresAt,
            payload.UserId
        ));
    }

    private static string MaskPrefix(string? token)
    {
        if (string.IsNullOrWhiteSpace(token)) return "<empty>";
        int len = Math.Min(16, token.Length);
        return token[..len];
    }
}
