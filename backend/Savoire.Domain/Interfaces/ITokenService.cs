// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Savoire.Domain.Aggregates;
using Savoire.Domain.Entities;

namespace Savoire.Domain.Interfaces;

public interface ITokenService
{
    string GenerateAccessToken(AppUser user);

    /// <summary>
    /// Generates a scoped JWT for a share link holder (no user account required).
    /// The token carries resource claims so handlers can validate access without a DB lookup.
    /// sub = "share:{link.Id}"
    /// </summary>
    string GenerateShareLinkAccessToken(ShareLink link);

    /// <summary>
    /// Generates a short-lived grant token used to bootstrap an iframe view session.
    /// This token is redeemed once by /api/v1/view/grants/redeem.
    /// </summary>
    string GenerateViewGrantToken(ViewGrantPayload payload);

    /// <summary>
    /// Validates and decodes a view grant token.
    /// </summary>
    ViewGrantPayload ReadViewGrantToken(string grantToken);

    /// <summary>
    /// Generates a scoped JWT for iframe document access.
    /// sub = "view:{vaultId}:{docId}:{permission}"
    /// </summary>
    string GenerateViewAccessToken(ViewGrantPayload payload);

    Task<RefreshToken> GenerateRefreshTokenAsync(AppUser user, string clientIp);
    Task<(AppUser user, RefreshToken newRefreshToken)> RotateRefreshTokenAsync(
        string rawToken, string clientIp);
    Task RevokeRefreshTokenAsync(string rawToken);
    Task RevokeAllUserRefreshTokensAsync(string userId);
}

public sealed record ViewGrantPayload(
    string VaultId,
    string DocId,
    string Path,
    string Permission,
    string? UserId,
    DateTime ExpiresAtUtc
);
