// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Schema « access-token » : les jetons personnels de l'API ouverte
// (Authorization: Bearer svp_...). Il n'est branche que sur les routes de
// l'API ouverte ; sur les autres, un tel jeton part au schema OIDC et echoue.
//
// Un jeton revoque, expire, ou dont le compte est bloque ou supprime est
// refuse. Claims : sub (la personne), token_id, token_scope, token_vaults.
using System.Security.Claims;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Savoire.Application.AccessTokens;
using Savoire.Domain.Entities;
using Savoire.Domain.ReadModels;
using Savoire.Domain.Repositories;

namespace Savoire.Infrastructure.Auth;

public sealed class AccessTokenAuthenticationHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options,
    ILoggerFactory logger,
    UrlEncoder encoder,
    IAccessTokenRepository tokens,
    UserManager<AppUser> users)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public const string Scheme = "access-token";
    public const string TokenIdClaim = "token_id";
    public const string ScopeClaim = "token_scope";
    /// <summary>Ids des vaults permis, separes par des virgules ; absent : tous.</summary>
    public const string VaultsClaim = "token_vaults";

    /// <summary>Derniere utilisation : ecrite au plus toutes les 5 minutes.</summary>
    private static readonly TimeSpan TouchEvery = TimeSpan.FromMinutes(5);

    protected override async Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        string? header = Request.Headers.Authorization;
        if (header is null || !header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)) return AuthenticateResult.NoResult();
        string token = header["Bearer ".Length..].Trim();
        if (!AccessTokenFormat.LooksLike(token)) return AuthenticateResult.NoResult();

        CancellationToken ct = Context.RequestAborted;
        AccessToken? t = await tokens.GetByHashAsync(AccessTokenFormat.Hash(token), ct);
        DateTime now = DateTime.UtcNow;
        if (t is null || t.RevokedAt is not null || (t.ExpiresAt is DateTime end && end <= now))
            return AuthenticateResult.Fail("Jeton inconnu, revoque ou expire.");

        AppUser? user = await users.FindByIdAsync(t.UserId);
        if (user is null || (user.LockoutEnd is { } lockout && lockout > DateTimeOffset.UtcNow))
            return AuthenticateResult.Fail("Compte indisponible.");

        if (t.LastUsedAt is null || t.LastUsedAt < now - TouchEvery)
            await tokens.TouchAsync(t.Id, now, ct);

        var claims = new List<Claim>
        {
            new("sub", t.UserId),
            new(TokenIdClaim, t.Id),
            new(ScopeClaim, t.Scope),
            new("display_name", user.DisplayName),
            new("is_admin", "false"),
        };
        if (t.VaultIds is not null) claims.Add(new Claim(VaultsClaim, string.Join(',', t.VaultIds)));
        var principal = new ClaimsPrincipal(new ClaimsIdentity(claims, Scheme, "sub", null));
        return AuthenticateResult.Success(new AuthenticationTicket(principal, Scheme));
    }

    protected override Task HandleChallengeAsync(AuthenticationProperties properties)
    {
        Response.StatusCode = StatusCodes401;
        Response.Headers.WWWAuthenticate = "Bearer realm=\"savoire\", error=\"invalid_token\"";
        return Task.CompletedTask;
    }

    private const int StatusCodes401 = 401;
}
