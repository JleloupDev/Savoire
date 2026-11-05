// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// D'un jeton du fournisseur d'identite a un compte Savoire (ADR-028).
//
// Le compte a pour id le sujet du jeton (« sub ») : stable chez l'IdP, unique
// dans son instance. Il est cree a la premiere requete, avec l'adresse et le
// nom lus dans le jeton, ou a defaut chez l'IdP (userinfo : un jeton d'acces
// Zitadel ne les porte pas). Ensuite, l'etat du compte (administrateur,
// bloque) est garde une minute en memoire : un blocage prend effet en une
// minute au plus.

using System.Net.Http.Headers;
using System.Text.Json;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Savoire.Domain.Entities;
using Savoire.Domain.Interfaces;

namespace Savoire.Infrastructure.Auth;

/// <summary>Ce que l'API sait d'un compte pendant une requete.</summary>
public sealed record OidcAccount(string Id, string DisplayName, string? Email, bool IsAdmin);

/// <summary>Ce que l'IdP dit de la personne (jeton, ou userinfo).</summary>
public sealed record OidcProfile(string? Email, bool EmailVerified, string? Name, string? PreferredUsername);

/// <summary>Le cache de OidcAccountResolver, vu du reste de l'application.</summary>
public sealed class OidcAccountCache(IMemoryCache cache) : IAccountCache
{
    public static string Key(string subject) => "oidc-account:" + subject;
    public void Forget(string userId) => cache.Remove(Key(userId));
}

public sealed class OidcAccountResolver(
    UserManager<AppUser> users,
    IMemoryCache cache,
    IHttpClientFactory http,
    IOptionsMonitor<AuthOptions> authOptions,
    ILogger<OidcAccountResolver> logger)
{
    public const string HttpClientName = "oidc-userinfo";
    private static readonly TimeSpan CacheFor = TimeSpan.FromMinutes(1);

    /// <summary>
    /// Le compte du sujet, cree s'il le faut ; null s'il est bloque.
    /// <paramref name="profile"/> : ce que porte le jeton ; <paramref name="userInfo"/>
    /// complete chez l'IdP quand l'adresse manque (premiere connexion seulement).
    /// </summary>
    public async Task<OidcAccount?> ResolveAsync(
        string subject, OidcProfile profile, Func<CancellationToken, Task<OidcProfile?>> userInfo, CancellationToken ct)
    {
        string key = OidcAccountCache.Key(subject);
        if (cache.TryGetValue(key, out OidcAccount? cached)) return cached;

        AppUser? user = await users.FindByIdAsync(subject);
        if (user is null)
        {
            if (profile.Email is null) profile = await userInfo(ct) ?? profile;
            user = await CreateAsync(subject, profile);
        }
        else
        {
            // Compte cree avant que l'adresse soit verifiee : on la reprend
            // des qu'elle l'est (au plus une fois par minute, voir CacheFor).
            OidcProfile? fresh = null;
            if (user.Email is null)
                fresh = profile.Email is not null && profile.EmailVerified ? profile : await userInfo(ct);
            await RefreshAsync(user, fresh);
        }

        bool blocked = user.LockoutEnd is { } end && end > DateTimeOffset.UtcNow;
        OidcAccount? account = blocked ? null : new OidcAccount(user.Id, user.DisplayName, user.Email, user.IsAdmin);
        cache.Set(key, account, CacheFor);
        return account;
    }

    private bool IsAdminEmail(string? email, bool verified) =>
        verified && email is not null
        && authOptions.CurrentValue.AdminEmails.Any(a => string.Equals(a.Trim(), email, StringComparison.OrdinalIgnoreCase));

    private async Task<AppUser> CreateAsync(string subject, OidcProfile profile)
    {
        // Seule une adresse verifiee par l'IdP est gardee : on invite par
        // adresse, une adresse non verifiee permettrait de se faire passer
        // pour quelqu'un d'autre.
        string? email = !profile.EmailVerified || string.IsNullOrWhiteSpace(profile.Email) ? null : profile.Email.Trim();
        // Une adresse deja prise par un autre compte (deux comptes chez l'IdP) :
        // le nouveau compte n'en a pas, la recherche par adresse reste sans ambiguite.
        if (email is not null && await users.FindByEmailAsync(email) is not null)
        {
            logger.LogWarning("Compte {Subject} : adresse deja utilisee par un autre compte, non reprise.", subject);
            email = null;
        }
        var user = new AppUser
        {
            Id = subject,
            UserName = subject,
            Email = email,
            EmailConfirmed = email is not null,
            DisplayName = FirstNonEmpty(profile.Name, profile.PreferredUsername, email) ?? "Utilisateur",
            IsAdmin = IsAdminEmail(email, verified: email is not null),
            LastLoginAt = DateTime.UtcNow,
        };
        IdentityResult result = await users.CreateAsync(user);
        if (result.Succeeded)
        {
            logger.LogInformation("Compte {Subject} cree (premiere connexion).", subject);
            return user;
        }
        // Deux premieres requetes en meme temps (page et WebSocket) : l'autre l'a cree.
        return await users.FindByIdAsync(subject)
            ?? throw new InvalidOperationException("Compte : creation impossible : "
                + string.Join(", ", result.Errors.Select(e => e.Description)));
    }

    /// <summary>
    /// Adresse verifiee depuis, administrateur ajoute a la liste depuis,
    /// derniere connexion (au plus une fois l'heure).
    /// </summary>
    private async Task RefreshAsync(AppUser user, OidcProfile? fresh)
    {
        bool changed = false;
        if (user.Email is null && fresh is { EmailVerified: true, Email: { Length: > 0 } email }
            && await users.FindByEmailAsync(email.Trim()) is null)
        {
            user.Email = email.Trim();
            user.NormalizedEmail = users.NormalizeEmail(user.Email);
            user.EmailConfirmed = true;
            changed = true;
        }
        if (!user.IsAdmin && IsAdminEmail(user.Email, user.EmailConfirmed)) { user.IsAdmin = true; changed = true; }
        if (user.LastLoginAt is null || user.LastLoginAt < DateTime.UtcNow.AddHours(-1)) { user.LastLoginAt = DateTime.UtcNow; changed = true; }
        if (changed) await users.UpdateAsync(user);
    }

    private static string? FirstNonEmpty(params string?[] values) =>
        values.FirstOrDefault(v => !string.IsNullOrWhiteSpace(v))?.Trim();

    /// <summary>Profil lu chez l'IdP (userinfo) avec le jeton de la personne.</summary>
    public async Task<OidcProfile?> FetchUserInfoAsync(string? endpoint, string accessToken, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(endpoint)) return null;
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, endpoint);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
            using HttpResponseMessage response = await http.CreateClient(HttpClientName).SendAsync(request, ct);
            if (!response.IsSuccessStatusCode)
            {
                logger.LogWarning("userinfo : {Status}.", (int)response.StatusCode);
                return null;
            }
            using JsonDocument doc = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(ct), cancellationToken: ct);
            JsonElement root = doc.RootElement;
            return new OidcProfile(
                Str(root, "email"),
                root.TryGetProperty("email_verified", out JsonElement v) && v.ValueKind == JsonValueKind.True,
                Str(root, "name"),
                Str(root, "preferred_username"));
        }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException)
        {
            logger.LogWarning(ex, "userinfo injoignable.");
            return null;
        }
    }

    private static string? Str(JsonElement root, string name) =>
        root.TryGetProperty(name, out JsonElement e) && e.ValueKind == JsonValueKind.String ? e.GetString() : null;
}
