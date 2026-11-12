// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Deux sortes de jetons, un seul point d'entree (schema « Bearer ») :
//  - « oidc » : les comptes, jetons du fournisseur d'identite (ADR-028),
//    verifies par ses cles publiees (JWKS) ;
//  - « savoire » : jetons signes par Savoire (secret Jwt:Secret), pour les
//    liens de partage et les vues integrees, sans compte.
// Un troisieme schema, « access-token » (jetons personnels svp_...), ne sert
// que sur l'API ouverte, ou il est demande explicitement.
// Le choix se fait sur l'emetteur du jeton (lu sans verification : la
// verification est faite ensuite par le schema choisi).

using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;
using Microsoft.IdentityModel.Tokens;

namespace Savoire.Infrastructure.Auth;

public static class AuthenticationSetup
{
    public const string OidcScheme = "oidc";
    public const string SavoireScheme = "savoire";

    /// <summary>Claim des comptes de service reconnus (valeur : « indexer »).</summary>
    public const string ServiceClaim = Savoire.Application.Indexer.IndexerOptions.PeerClaim;

    public static IServiceCollection AddSavoireAuthentication(this IServiceCollection services, IConfiguration config)
    {
        services.Configure<OidcOptions>(config.GetSection(OidcOptions.Section));
        services.Configure<AuthOptions>(config.GetSection(AuthOptions.Section));
        services.AddMemoryCache();
        services.AddHttpClient(OidcAccountResolver.HttpClientName, c => c.Timeout = TimeSpan.FromSeconds(10));
        services.AddScoped<OidcAccountResolver>();
        services.AddSingleton<Savoire.Domain.Interfaces.IAccountCache, OidcAccountCache>();

        services
            .AddAuthentication(options =>
            {
                options.DefaultScheme = JwtBearerDefaults.AuthenticationScheme;
                options.DefaultAuthenticateScheme = JwtBearerDefaults.AuthenticationScheme;
                options.DefaultChallengeScheme = JwtBearerDefaults.AuthenticationScheme;
            })
            .AddPolicyScheme(JwtBearerDefaults.AuthenticationScheme, "Bearer", options =>
            {
                options.ForwardDefaultSelector = ctx =>
                    IssuerOf(ReadToken(ctx.Request)) == LocalIssuer(config) ? SavoireScheme : OidcScheme;
            })
            .AddJwtBearer(SavoireScheme, options =>
            {
                options.MapInboundClaims = false;
                options.TokenValidationParameters = new TokenValidationParameters
                {
                    ValidateIssuerSigningKey = true,
                    // Lu a chaque validation : la configuration peut arriver apres.
                    IssuerSigningKeyResolver = (_, _, _, _) =>
                    {
                        string secret = config["Jwt:Secret"]
                            ?? throw new InvalidOperationException("Jwt:Secret manquant.");
                        return [new SymmetricSecurityKey(Encoding.UTF8.GetBytes(secret))];
                    },
                    ValidateIssuer = true,
                    ValidIssuer = LocalIssuer(config),
                    ValidateAudience = true,
                    ValidAudience = config["Jwt:Audience"] ?? "vault-client",
                    ValidateLifetime = true,
                    ClockSkew = TimeSpan.FromSeconds(30),
                };
                options.Events = new JwtBearerEvents { OnMessageReceived = HubToken };
            })
            // Jetons personnels de l'API ouverte : seulement sur ses routes.
            .AddScheme<AuthenticationSchemeOptions, AccessTokenAuthenticationHandler>(AccessTokenAuthenticationHandler.Scheme, null)
            .AddJwtBearer(OidcScheme, options =>
            {
                options.MapInboundClaims = false;
                options.Events = new JwtBearerEvents
                {
                    OnMessageReceived = HubToken,
                    OnTokenValidated = ResolveAccountAsync,
                };
            });

        // Valeurs lues a la resolution (les tests et le fichier de bootstrap.mjs
        // arrivent apres l'enregistrement).
        services.AddOptions<JwtBearerOptions>(OidcScheme).Configure<Microsoft.Extensions.Options.IOptionsMonitor<OidcOptions>>((options, oidcMonitor) =>
        {
            OidcOptions oidc = oidcMonitor.CurrentValue;
            if (!oidc.Enabled) return;
            options.Authority = oidc.Authority!.TrimEnd('/');
            options.Audience = oidc.Audience;
            options.RequireHttpsMetadata = oidc.RequireHttpsMetadata;
            options.TokenValidationParameters.ValidateIssuer = true;
            options.TokenValidationParameters.ValidateAudience = true;
            options.TokenValidationParameters.ValidateLifetime = true;
            options.TokenValidationParameters.ClockSkew = TimeSpan.FromSeconds(30);
            options.TokenValidationParameters.NameClaimType = "sub";
        });

        services.AddAuthorization(options =>
        {
            options.AddPolicy("AdminOnly", policy => policy.RequireClaim("is_admin", "true"));
        });
        return services;
    }

    private static string LocalIssuer(IConfiguration config) => config["Jwt:Issuer"] ?? "vault-server";

    /// <summary>SignalR (WebSocket) : le jeton arrive dans la query string.</summary>
    private static Task HubToken(MessageReceivedContext context)
    {
        string? token = context.Request.Query["access_token"];
        if (!string.IsNullOrEmpty(token) && context.HttpContext.Request.Path.StartsWithSegments("/hubs"))
            context.Token = token;
        return Task.CompletedTask;
    }

    private static string? ReadToken(HttpRequest request)
    {
        string? header = request.Headers.Authorization;
        if (header is not null && header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
            return header["Bearer ".Length..].Trim();
        if (request.Path.StartsWithSegments("/hubs")) return request.Query["access_token"];
        return null;
    }

    private static string? IssuerOf(string? token)
    {
        if (string.IsNullOrEmpty(token)) return null;
        try { return new JsonWebToken(token).Issuer; }
        catch (ArgumentException) { return null; }
    }

    /// <summary>
    /// Jeton de l'IdP valide : le compte Savoire du sujet (cree a la premiere
    /// connexion), ou le compte de service reconnu. Un compte bloque est refuse.
    /// </summary>
    private static async Task ResolveAccountAsync(TokenValidatedContext context)
    {
        ClaimsPrincipal principal = context.Principal!;
        var identity = (ClaimsIdentity)principal.Identity!;
        string? subject = principal.FindFirstValue("sub");
        if (string.IsNullOrEmpty(subject)) { context.Fail("Jeton sans sujet."); return; }

        IServiceProvider services = context.HttpContext.RequestServices;
        IConfiguration config = services.GetRequiredService<IConfiguration>();

        // Comptes de service (client credentials) : pas de compte Savoire.
        string? peer = config["Indexer:Oidc:PeerSubject"];
        if (!string.IsNullOrEmpty(peer) && subject == peer)
        {
            identity.AddClaim(new Claim(ServiceClaim, "indexer"));
            return;
        }

        string rawToken = context.SecurityToken switch
        {
            JsonWebToken jwt => jwt.EncodedToken,
            JwtSecurityToken jwt => jwt.RawData,
            _ => string.Empty,
        };
        var profile = new OidcProfile(
            principal.FindFirstValue("email"),
            principal.FindFirstValue("email_verified") == "true",
            principal.FindFirstValue("name"),
            principal.FindFirstValue("preferred_username"));

        var resolver = services.GetRequiredService<OidcAccountResolver>();
        CancellationToken ct = context.HttpContext.RequestAborted;
        OidcAccount? account;
        try
        {
            account = await resolver.ResolveAsync(subject, profile, async c =>
            {
                OpenIdConnectConfiguration? oidc = context.Options.ConfigurationManager is { } manager
                    ? await manager.GetConfigurationAsync(c)
                    : context.Options.Configuration;
                return await resolver.FetchUserInfoAsync(oidc?.UserInfoEndpoint, rawToken, c);
            }, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            services.GetRequiredService<ILoggerFactory>().CreateLogger(typeof(AuthenticationSetup))
                .LogError(ex, "Compte {Subject} : resolution impossible.", subject);
            context.Fail("Compte indisponible.");
            return;
        }

        if (account is null) { context.Fail("Compte bloque."); return; }
        identity.AddClaim(new Claim("is_admin", account.IsAdmin ? "true" : "false"));
        identity.AddClaim(new Claim("display_name", account.DisplayName));
        if (account.Email is not null && principal.FindFirst("email") is null)
            identity.AddClaim(new Claim("email", account.Email));
    }
}
