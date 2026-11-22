// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les comptes : ceux de Savoire (Zitadel, ADR-028 de Savoire). Le store
// verifie les jetons d'acces du meme fournisseur d'identite, pour le meme
// projet : un compte Savoire suffit pour laisser un avis ou publier.
//
// Le nom affiche (avis, auteur) vient du jeton, sinon de l'endpoint userinfo
// de l'IdP (Zitadel ne met ni nom ni adresse dans ses jetons d'acces).
using System.Net.Http.Headers;
using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;

namespace SavoireStore.Auth;

public sealed record StoreUser(string Id, string Name, string? Email, bool IsAdmin);

public sealed class StoreUsers(
    IHttpContextAccessor accessor,
    IMemoryCache cache,
    IHttpClientFactory http,
    IOptionsMonitor<JwtBearerOptions> jwt,
    IConfiguration config,
    ILogger<StoreUsers> logger)
{
    public const string HttpClientName = "userinfo";

    public async Task<StoreUser> CurrentAsync(CancellationToken ct)
    {
        HttpContext ctx = accessor.HttpContext ?? throw new InvalidOperationException("Hors requete.");
        ClaimsPrincipal p = ctx.User;
        string id = p.FindFirstValue("sub") ?? throw new UnauthorizedAccessException();
        string? name = p.FindFirstValue("name") ?? p.FindFirstValue("preferred_username");
        string? email = p.FindFirstValue("email_verified") == "true" ? p.FindFirstValue("email") : null;
        if (name is null || email is null)
        {
            (string? Name, string? Email) info = await UserInfoAsync(id, ctx, ct);
            name ??= info.Name;
            email ??= info.Email;
        }
        return new StoreUser(id, Clean(name) ?? "Compte Savoire", email, IsAdmin(id, email));
    }

    private bool IsAdmin(string id, string? email)
    {
        string[] subjects = config.GetSection("Store:AdminSubjects").Get<string[]>() ?? [];
        string[] emails = config.GetSection("Store:AdminEmails").Get<string[]>() ?? [];
        return subjects.Contains(id)
            || (email is not null && emails.Any(e => string.Equals(e.Trim(), email, StringComparison.OrdinalIgnoreCase)));
    }

    private async Task<(string? Name, string? Email)> UserInfoAsync(string id, HttpContext ctx, CancellationToken ct)
    {
        string key = "userinfo:" + id;
        if (cache.TryGetValue(key, out (string?, string?) cached)) return cached;
        (string? Name, string? Email) result = (null, null);
        try
        {
            string? header = ctx.Request.Headers.Authorization;
            JwtBearerOptions o = jwt.Get(JwtBearerDefaults.AuthenticationScheme);
            OpenIdConnectConfiguration? oidc = o.ConfigurationManager is { } m ? await m.GetConfigurationAsync(ct) : o.Configuration;
            if (header is not null && oidc?.UserInfoEndpoint is { Length: > 0 } endpoint)
            {
                using var req = new HttpRequestMessage(HttpMethod.Get, endpoint);
                req.Headers.Authorization = AuthenticationHeaderValue.Parse(header);
                using HttpResponseMessage resp = await http.CreateClient(HttpClientName).SendAsync(req, ct);
                if (resp.IsSuccessStatusCode)
                {
                    using JsonDocument doc = JsonDocument.Parse(await resp.Content.ReadAsStreamAsync(ct));
                    JsonElement r = doc.RootElement;
                    string? Prop(string n) => r.TryGetProperty(n, out JsonElement e) && e.ValueKind == JsonValueKind.String ? e.GetString() : null;
                    bool verified = r.TryGetProperty("email_verified", out JsonElement ev) && ev.ValueKind == JsonValueKind.True;
                    result = (Prop("name") ?? Prop("preferred_username"), verified ? Prop("email") : null);
                }
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "userinfo indisponible pour {Subject}.", id);
        }
        cache.Set(key, result, TimeSpan.FromMinutes(10));
        return result;
    }

    private static string? Clean(string? s)
    {
        if (string.IsNullOrWhiteSpace(s)) return null;
        s = s.Trim();
        return s.Length > 100 ? s[..100] : s;
    }
}
