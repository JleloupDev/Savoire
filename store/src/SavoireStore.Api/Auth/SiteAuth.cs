// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Se connecter au site du store avec son compte Savoire, pour laisser un avis
// ou repondre a ceux de ses elements depuis le navigateur.
//
//  - l'API ne change pas : jeton Bearer seulement (route /api) ;
//  - le site : un cookie (HttpOnly, SameSite=Lax), pose apres une connexion
//    OIDC par code + PKCE chez Zitadel, avec l'appli web de Savoire
//    (Auth:ClientId ; adresse de retour <store>/auth/callback declaree chez
//    Zitadel par zitadel-bootstrap).
//
// Le jeton d'acces recu est verifie comme ceux de l'API (emetteur, audience,
// signature) ; il n'est pas garde : le cookie ne porte que le compte.
// Les cles du cookie (et des jetons anti-CSRF) sont gardees en base.
using System.Net.Http.Headers;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text.Json;
using System.Xml.Linq;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.DataProtection.KeyManagement;
using Microsoft.AspNetCore.DataProtection.Repositories;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;
using Microsoft.IdentityModel.Tokens;
using SavoireStore.Data;

namespace SavoireStore.Auth;

public static class SiteAuth
{
    /// <summary>Le cookie du site.</summary>
    public const string Scheme = "site";
    /// <summary>Choisit Bearer pour /api, le cookie pour le reste.</summary>
    public const string Selector = "bearer-or-site";
    public const string HttpClientName = "oidc";
    private const string LoginCookie = "savoire_store_login";
    private const string Purpose = "SavoireStore.SiteLogin.v1";

    public static void Add(WebApplicationBuilder builder)
    {
        builder.Services.AddAuthentication(Selector)
            .AddPolicyScheme(Selector, "Bearer ou cookie", o => o.ForwardDefaultSelector = ctx =>
                ctx.Request.Path.StartsWithSegments("/api") ? JwtBearerDefaults.AuthenticationScheme : Scheme)
            .AddJwtBearer()
            .AddCookie(Scheme, o =>
            {
                o.Cookie.Name = "savoire_store";
                o.Cookie.HttpOnly = true;
                o.Cookie.SameSite = SameSiteMode.Lax;
                o.Cookie.SecurePolicy = CookieSecurePolicy.SameAsRequest;
                o.ExpireTimeSpan = TimeSpan.FromDays(30);
                o.SlidingExpiration = true;
                o.Events.OnRedirectToLogin = ctx => { ctx.Response.StatusCode = 401; return Task.CompletedTask; };
                o.Events.OnRedirectToAccessDenied = ctx => { ctx.Response.StatusCode = 403; return Task.CompletedTask; };
            });
        builder.Services.AddDataProtection().SetApplicationName("savoire-store");
        builder.Services.AddOptions<KeyManagementOptions>().Configure<IServiceScopeFactory>((o, scopes) => o.XmlRepository = new DbXmlRepository(scopes));
        builder.Services.AddAntiforgery(o =>
        {
            o.Cookie.Name = "savoire_store_csrf";
            o.Cookie.SecurePolicy = CookieSecurePolicy.SameAsRequest;
            o.FormFieldName = "_csrf";
        });
        builder.Services.AddHttpClient(HttpClientName, c => c.Timeout = TimeSpan.FromSeconds(10));
    }

    public static bool Enabled(IConfiguration config) => config["Auth:ClientId"] is { Length: > 0 };

    /// <summary>Une adresse de retour sure : un chemin du site, jamais un autre domaine.</summary>
    public static string SafeReturn(string? url) =>
        url is { Length: > 0 and < 500 } && url[0] == '/' && !url.StartsWith("//", StringComparison.Ordinal) && !url.Contains('\\') ? url : "/";

    private sealed record LoginState(string State, string Verifier, string ReturnUrl);

    public static void Map(WebApplication app)
    {
        app.MapGet("/auth/login", async (HttpContext ctx, IConfiguration config, IOptionsMonitor<JwtBearerOptions> jwt, IDataProtectionProvider dp, string? returnUrl, CancellationToken ct) =>
        {
            if (!Enabled(config)) return Results.Redirect($"{ctx.Request.PathBase}/?n=connexion-indisponible");
            OpenIdConnectConfiguration? oidc = await OidcAsync(jwt, ct);
            if (oidc?.AuthorizationEndpoint is not { Length: > 0 } authorize) return Results.Redirect($"{ctx.Request.PathBase}/?n=connexion-indisponible");
            string state = Random(), verifier = Random();
            string challenge = Base64UrlEncoder.Encode(SHA256.HashData(System.Text.Encoding.ASCII.GetBytes(verifier)));
            string payload = JsonSerializer.Serialize(new LoginState(state, verifier, SafeReturn(returnUrl)));
            ctx.Response.Cookies.Append(LoginCookie, dp.CreateProtector(Purpose).Protect(payload), new CookieOptions
            {
                HttpOnly = true, SameSite = SameSiteMode.Lax, Secure = ctx.Request.IsHttps, MaxAge = TimeSpan.FromMinutes(10),
                Path = (ctx.Request.PathBase.HasValue ? ctx.Request.PathBase.Value : "") + "/auth",
            });
            string url = QueryHelpers.AddQueryString(authorize, new Dictionary<string, string?>
            {
                ["client_id"] = config["Auth:ClientId"],
                ["redirect_uri"] = Callback(ctx),
                ["response_type"] = "code",
                ["scope"] = "openid profile email",
                ["state"] = state,
                ["code_challenge"] = challenge,
                ["code_challenge_method"] = "S256",
            });
            return Results.Redirect(url);
        });

        app.MapGet("/auth/callback", async (HttpContext ctx, IConfiguration config, IOptionsMonitor<JwtBearerOptions> jwt, IDataProtectionProvider dp,
            IHttpClientFactory http, StoreUsers users, ILoggerFactory logs, string? code, string? state, CancellationToken ct) =>
        {
            string home = ctx.Request.PathBase.Value ?? "";
            ILogger logger = logs.CreateLogger("SiteAuth");
            LoginState? login = null;
            try
            {
                if (ctx.Request.Cookies[LoginCookie] is { Length: > 0 } raw)
                    login = JsonSerializer.Deserialize<LoginState>(dp.CreateProtector(Purpose).Unprotect(raw));
            }
            catch (Exception ex) when (ex is CryptographicException or JsonException) { }
            ctx.Response.Cookies.Delete(LoginCookie, new CookieOptions { Path = home + "/auth" });
            if (login is null || code is null || state is null
                || !CryptographicOperations.FixedTimeEquals(System.Text.Encoding.ASCII.GetBytes(state), System.Text.Encoding.ASCII.GetBytes(login.State)))
                return Results.Redirect(home + "/?n=connexion-echouee");

            OpenIdConnectConfiguration? oidc = await OidcAsync(jwt, ct);
            if (oidc?.TokenEndpoint is not { Length: > 0 } tokenEndpoint) return Results.Redirect(home + "/?n=connexion-indisponible");
            string? accessToken = null;
            try
            {
                using var form = new FormUrlEncodedContent(new Dictionary<string, string>
                {
                    ["grant_type"] = "authorization_code",
                    ["code"] = code,
                    ["redirect_uri"] = Callback(ctx),
                    ["client_id"] = config["Auth:ClientId"]!,
                    ["code_verifier"] = login.Verifier,
                });
                using var req = new HttpRequestMessage(HttpMethod.Post, tokenEndpoint) { Content = form };
                req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
                using HttpResponseMessage resp = await http.CreateClient(HttpClientName).SendAsync(req, ct);
                if (resp.IsSuccessStatusCode)
                {
                    using JsonDocument doc = JsonDocument.Parse(await resp.Content.ReadAsStreamAsync(ct));
                    if (doc.RootElement.TryGetProperty("access_token", out JsonElement at)) accessToken = at.GetString();
                }
                else logger.LogWarning("Connexion au site : l'IdP a repondu {Status} a l'echange du code.", (int)resp.StatusCode);
            }
            catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException)
            {
                logger.LogWarning(ex, "Connexion au site : echange du code impossible.");
            }
            if (accessToken is null) return Results.Redirect(home + "/?n=connexion-echouee");

            // Verifie comme un jeton de l'API : emetteur, audience (le projet Savoire), signature, dates.
            JwtBearerOptions o = jwt.Get(JwtBearerDefaults.AuthenticationScheme);
            TokenValidationParameters tvp = o.TokenValidationParameters.Clone();
            tvp.ValidIssuer ??= oidc.Issuer;
            tvp.ValidAudience ??= o.Audience;
            if (tvp.IssuerSigningKey is null) tvp.IssuerSigningKeys = oidc.SigningKeys;
            TokenValidationResult result = await new JsonWebTokenHandler().ValidateTokenAsync(accessToken, tvp);
            if (!result.IsValid || result.ClaimsIdentity.FindFirst("sub")?.Value is not { Length: > 0 } sub)
            {
                logger.LogWarning(result.Exception, "Connexion au site : jeton d'acces refuse.");
                return Results.Redirect(home + "/?n=connexion-echouee");
            }
            string? name = result.ClaimsIdentity.FindFirst("name")?.Value ?? result.ClaimsIdentity.FindFirst("preferred_username")?.Value;
            string? email = result.ClaimsIdentity.FindFirst("email_verified")?.Value == "true" ? result.ClaimsIdentity.FindFirst("email")?.Value : null;
            if (name is null || email is null)
            {
                (string? Name, string? Email) info = await users.UserInfoAsync(sub, "Bearer " + accessToken, ct);
                name ??= info.Name;
                email ??= info.Email;
            }
            var claims = new List<Claim> { new("sub", sub), new("name", string.IsNullOrWhiteSpace(name) ? "Compte Savoire" : name) };
            if (email is not null) { claims.Add(new Claim("email", email)); claims.Add(new Claim("email_verified", "true")); }
            await ctx.SignInAsync(Scheme, new ClaimsPrincipal(new ClaimsIdentity(claims, Scheme, "name", null)));
            return Results.Redirect(home + login.ReturnUrl);
        });

        app.MapPost("/auth/logout", async (HttpContext ctx, Microsoft.AspNetCore.Antiforgery.IAntiforgery af) =>
        {
            string home = ctx.Request.PathBase.Value ?? "";
            if (!await af.IsRequestValidAsync(ctx)) return Results.Redirect(home + "/");
            await ctx.SignOutAsync(Scheme);
            IFormCollection form = await ctx.Request.ReadFormAsync();
            return Results.Redirect(home + SafeReturn(form["returnUrl"]));
        });
    }

    private static string Callback(HttpContext ctx) => $"{ctx.Request.Scheme}://{ctx.Request.Host}{ctx.Request.PathBase}/auth/callback";

    private static string Random() => Base64UrlEncoder.Encode(RandomNumberGenerator.GetBytes(32));

    private static async Task<OpenIdConnectConfiguration?> OidcAsync(IOptionsMonitor<JwtBearerOptions> jwt, CancellationToken ct)
    {
        JwtBearerOptions o = jwt.Get(JwtBearerDefaults.AuthenticationScheme);
        try { return o.ConfigurationManager is { } m ? await m.GetConfigurationAsync(ct) : o.Configuration; }
        catch (InvalidOperationException) { return null; }
    }
}

/// <summary>Les cles de protection des donnees, dans la table data_protection_keys.</summary>
public sealed class DbXmlRepository(IServiceScopeFactory scopes) : IXmlRepository
{
    public IReadOnlyCollection<XElement> GetAllElements()
    {
        using IServiceScope scope = scopes.CreateScope();
        StoreDb db = scope.ServiceProvider.GetRequiredService<StoreDb>();
        return db.DataProtectionKeys.AsEnumerable().Select(k => XElement.Parse(k.Xml)).ToList();
    }

    public void StoreElement(XElement element, string friendlyName)
    {
        using IServiceScope scope = scopes.CreateScope();
        StoreDb db = scope.ServiceProvider.GetRequiredService<StoreDb>();
        db.DataProtectionKeys.Add(new DataProtectionKeyRow { FriendlyName = friendlyName, Xml = element.ToString(SaveOptions.DisableFormatting) });
        db.SaveChanges();
    }
}
