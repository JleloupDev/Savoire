// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Connexion par le fournisseur d'identite (ADR-028) : ou se connecter, et le
// compte Savoire de la personne connectee.
using MediatR;
using Microsoft.Extensions.Configuration;
using Savoire.Application.Auth.DTOs;
using Savoire.Domain.Interfaces;

namespace Savoire.Application.Auth.Queries;

/// <summary>L'IdP et les applis declarees ; null si ce serveur n'en a pas.</summary>
public sealed record GetAuthConfigQuery : IRequest<AuthConfigDto?>;

public sealed class GetAuthConfigQueryHandler(IConfiguration config) : IRequestHandler<GetAuthConfigQuery, AuthConfigDto?>
{
    public Task<AuthConfigDto?> Handle(GetAuthConfigQuery request, CancellationToken ct)
    {
        IConfigurationSection oidc = config.GetSection("Auth:Oidc");
        string? issuer = oidc["Authority"]?.TrimEnd('/');
        string? webClientId = oidc["WebClientId"];
        if (string.IsNullOrWhiteSpace(issuer) || string.IsNullOrWhiteSpace(webClientId))
            return Task.FromResult<AuthConfigDto?>(null);
        string? desktop = oidc["DesktopClientId"];
        return Task.FromResult<AuthConfigDto?>(new AuthConfigDto(
            issuer,
            webClientId,
            string.IsNullOrWhiteSpace(desktop) ? null : desktop,
            oidc["Scopes"] ?? "openid profile email offline_access"));
    }
}

/// <summary>Le compte de la personne connectee ; null s'il n'existe pas.</summary>
public sealed record GetCurrentUserQuery(string UserId) : IRequest<AuthUserDto?>;

public sealed class GetCurrentUserQueryHandler(IUserService users) : IRequestHandler<GetCurrentUserQuery, AuthUserDto?>
{
    public async Task<AuthUserDto?> Handle(GetCurrentUserQuery request, CancellationToken ct)
    {
        UserRecord? user = await users.GetUserAsync(request.UserId, ct);
        return user is null ? null : new AuthUserDto(user.Id, user.DisplayName, user.Email, user.IsAdmin);
    }
}
