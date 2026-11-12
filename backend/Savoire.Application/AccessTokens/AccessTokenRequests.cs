// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Jetons personnels de l'API ouverte (ChatGPT, Claude, scripts, n8n...).
//
// Un jeton agit au nom de la personne qui l'a cree, avec ses droits, et
// seulement sur les vaults choisis (tous, s'il n'y en a pas). Il ne sert que
// sur l'API ouverte (/api/open/v1, /api/mcp) : jamais sur les routes de
// l'application. Le serveur n'en garde que l'empreinte ; le jeton complet
// n'est montre qu'a sa creation. Revocable a tout moment.
using System.Security.Cryptography;
using System.Text;
using FluentValidation;
using FluentValidation.Results;
using MediatR;
using Savoire.Domain.Exceptions;
using Savoire.Domain.ReadModels;
using Savoire.Domain.Repositories;

namespace Savoire.Application.AccessTokens;

public static class AccessTokenFormat
{
    public const string Prefix = "svp_";
    public const string ReadScope = "read";
    public const int MaxActivePerUser = 50;
    public const int MaxVaults = 100;
    public const int MaxNameChars = 100;
    public const int MaxDays = 3650;

    /// <summary>Un nouveau jeton : 32 octets aleatoires, en base64url.</summary>
    public static string Generate()
    {
        string body = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');
        return Prefix + body;
    }

    /// <summary>Empreinte gardee en base (SHA-256, hexadecimal).</summary>
    public static string Hash(string token) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(token)));

    /// <summary>A la forme d'un jeton personnel (pas d'un JWT).</summary>
    public static bool LooksLike(string? token) =>
        token is { Length: > 20 and < 200 } && token.StartsWith(Prefix, StringComparison.Ordinal);

    /// <summary>Le debut, pour reconnaitre le jeton dans la liste.</summary>
    public static string Display(string token) => token[..Math.Min(token.Length, Prefix.Length + 6)];
}

public sealed record AccessTokenDto(
    string Id, string Name, string Prefix, string Scope, IReadOnlyList<string>? VaultIds,
    DateTime CreatedAt, DateTime? ExpiresAt, DateTime? LastUsedAt, bool Revoked);

/// <summary>Le jeton complet n'est rendu qu'ici, une seule fois.</summary>
public sealed record CreatedAccessTokenDto(string Token, AccessTokenDto Info);

public sealed record CreateAccessTokenCommand(string CallerId, string Name, IReadOnlyList<string>? VaultIds, int? ExpiresInDays)
    : IRequest<CreatedAccessTokenDto>;

public sealed record ListAccessTokensQuery(string CallerId) : IRequest<IReadOnlyList<AccessTokenDto>>;

public sealed record RevokeAccessTokenCommand(string CallerId, string Id) : IRequest;

internal static class AccessTokens
{
    public static AccessTokenDto ToDto(AccessToken t) => new(
        t.Id, t.Name, t.Prefix, t.Scope, t.VaultIds, t.CreatedAt, t.ExpiresAt, t.LastUsedAt, t.RevokedAt is not null);

    public static void RequireAccount(string callerId)
    {
        if (Sharing.ShareLinkGuard.IsShareLinkCaller(callerId) || Sharing.ShareLinkGuard.IsViewCaller(callerId))
            throw new AccessDeniedException("Un lien de partage ne peut pas creer de jeton.");
    }
}

public sealed class CreateAccessTokenCommandValidator : AbstractValidator<CreateAccessTokenCommand>
{
    public CreateAccessTokenCommandValidator()
    {
        RuleFor(c => c.Name).NotEmpty().WithMessage("Donnez un nom au jeton.")
            .MaximumLength(AccessTokenFormat.MaxNameChars);
        RuleFor(c => c.ExpiresInDays).InclusiveBetween(1, AccessTokenFormat.MaxDays).When(c => c.ExpiresInDays is not null);
        RuleFor(c => c.VaultIds).Must(v => v is null || (v.Count > 0 && v.Count <= AccessTokenFormat.MaxVaults))
            .WithMessage("Choisissez au moins un vault (ou tous).");
    }
}

public sealed class CreateAccessTokenCommandHandler(IAccessTokenRepository tokens, IVaultRepository vaults)
    : IRequestHandler<CreateAccessTokenCommand, CreatedAccessTokenDto>
{
    public async Task<CreatedAccessTokenDto> Handle(CreateAccessTokenCommand c, CancellationToken ct)
    {
        AccessTokens.RequireAccount(c.CallerId);
        DateTime now = DateTime.UtcNow;
        if (await tokens.CountActiveForUserAsync(c.CallerId, now, ct) >= AccessTokenFormat.MaxActivePerUser)
            throw new ValidationException([new ValidationFailure("name", "Trop de jetons actifs : revoquez-en un d'abord.")]);

        IReadOnlyList<string>? vaultIds = null;
        if (c.VaultIds is not null)
        {
            // Seulement des vaults de la personne : un jeton ne donne jamais plus que ses droits.
            HashSet<string> mine = (await vaults.GetForUserAsync(c.CallerId, ct)).Select(v => v.Vault.Id).ToHashSet();
            vaultIds = c.VaultIds.Distinct().ToList();
            if (vaultIds.Any(id => !mine.Contains(id)))
                throw new ValidationException([new ValidationFailure("vaultIds", "Un des vaults choisis ne vous est pas accessible.")]);
        }

        string token = AccessTokenFormat.Generate();
        var record = new AccessToken(
            Guid.NewGuid().ToString("N"), c.CallerId, c.Name.Trim(), AccessTokenFormat.Display(token),
            AccessTokenFormat.Hash(token), AccessTokenFormat.ReadScope, vaultIds,
            now, c.ExpiresInDays is int days ? now.AddDays(days) : null, null, null);
        await tokens.AddAsync(record, ct);
        return new CreatedAccessTokenDto(token, AccessTokens.ToDto(record));
    }
}

public sealed class ListAccessTokensQueryHandler(IAccessTokenRepository tokens)
    : IRequestHandler<ListAccessTokensQuery, IReadOnlyList<AccessTokenDto>>
{
    public async Task<IReadOnlyList<AccessTokenDto>> Handle(ListAccessTokensQuery q, CancellationToken ct)
    {
        AccessTokens.RequireAccount(q.CallerId);
        return (await tokens.ListForUserAsync(q.CallerId, ct)).Select(AccessTokens.ToDto).ToList();
    }
}

public sealed class RevokeAccessTokenCommandHandler(IAccessTokenRepository tokens) : IRequestHandler<RevokeAccessTokenCommand>
{
    public async Task Handle(RevokeAccessTokenCommand c, CancellationToken ct)
    {
        AccessTokens.RequireAccount(c.CallerId);
        if (!await tokens.RevokeAsync(c.Id, c.CallerId, DateTime.UtcNow, ct))
            throw new DocumentNotFoundException(c.Id);
    }
}
