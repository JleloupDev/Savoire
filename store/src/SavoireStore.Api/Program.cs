// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Savoire Store : le catalogue des plugins, modeles de notes et modules de
// Savoire. Un site (rendu serveur, sans script) et une petite API.
// Meme pile que Savoire : ASP.NET, PostgreSQL, comptes Zitadel.
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using SavoireStore.Api;
using SavoireStore.Auth;
using SavoireStore.Data;
using SavoireStore.Publishing;
using SavoireStore.Signing;
using SavoireStore.Site;

WebApplicationBuilder builder = WebApplication.CreateBuilder(args);

// Deploiement avec Savoire (deploy/compose/docker-compose.store.yml) : le
// fournisseur d'identite est celui de Savoire ; son adresse et l'id du projet
// sont dans le fichier ecrit par zitadel-bootstrap (Auth.Oidc.Authority et
// Audience), designe par Store:OidcConfigFile.
if (builder.Configuration["Store:OidcConfigFile"] is { Length: > 0 } oidcFile && File.Exists(oidcFile))
{
    using var oidc = System.Text.Json.JsonDocument.Parse(File.ReadAllText(oidcFile));
    if (oidc.RootElement.TryGetProperty("Auth", out var auth) && auth.TryGetProperty("Oidc", out var o))
    {
        var values = new Dictionary<string, string?>();
        if (o.TryGetProperty("Authority", out var a)) values["Auth:Authority"] = a.GetString();
        if (o.TryGetProperty("Audience", out var aud)) values["Auth:Audience"] = aud.GetString();
        // Connexion au site : l'appli web de Savoire (code + PKCE).
        if (o.TryGetProperty("WebClientId", out var client)) values["Auth:ClientId"] = client.GetString();
        if (o.TryGetProperty("RequireHttpsMetadata", out var https)) values["Auth:RequireHttpsMetadata"] = https.ToString().ToLowerInvariant();
        builder.Configuration.AddInMemoryCollection(values);
    }
}

builder.Services.AddDbContext<StoreDb>(o => o.UseNpgsql(builder.Configuration.GetConnectionString("Store")
    ?? throw new InvalidOperationException("ConnectionStrings:Store manquant.")));

// Comptes Savoire : jetons d'acces de Zitadel, pour le projet Savoire (API) ;
// cookie apres une connexion OIDC (site, voir SiteAuth).
SiteAuth.Add(builder);
builder.Services.AddOptions<JwtBearerOptions>(JwtBearerDefaults.AuthenticationScheme).Configure<IConfiguration>((o, config) =>
{
    o.MapInboundClaims = false;
    o.Authority = config["Auth:Authority"]?.TrimEnd('/');
    o.Audience = config["Auth:Audience"];
    o.RequireHttpsMetadata = config.GetValue("Auth:RequireHttpsMetadata", true);
    o.TokenValidationParameters.NameClaimType = "sub";
    o.TokenValidationParameters.ClockSkew = TimeSpan.FromSeconds(30);
});
builder.Services.AddAuthorization();
builder.Services.AddHttpContextAccessor();
builder.Services.AddMemoryCache();
builder.Services.AddHttpClient(StoreUsers.HttpClientName, c => c.Timeout = TimeSpan.FromSeconds(10));
builder.Services.AddHttpClient(GitHubReleases.HttpClientName, c => c.Timeout = TimeSpan.FromSeconds(30));
builder.Services.AddScoped<StoreUsers>();
builder.Services.AddScoped<GitHubReleases>();
builder.Services.AddScoped<PublishService>();
builder.Services.AddSingleton(sp =>
{
    IConfiguration config = sp.GetRequiredService<IConfiguration>();
    // Cle donnee dans la configuration (deploiement : variable Store__SigningKeyPem,
    // gardee dans le .env et donc dans la copie hors machine), sinon un fichier.
    if (config["Store:SigningKeyPem"] is { Length: > 0 } pem) return PackageSigner.FromPem(pem);
    string path = config["Store:SigningKeyFile"] is { Length: > 0 } f ? f : Path.Combine(builder.Environment.ContentRootPath, ".local", "signing-key.pem");
    return PackageSigner.Load(path, createIfMissing: builder.Environment.IsDevelopment() || config.GetValue("Store:CreateSigningKey", false));
});

// Ecritures (publier, avis) : 20 par minute et par compte.
builder.Services.AddRateLimiter(o =>
{
    o.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    o.AddPolicy(Program.WritesPolicy, ctx => RateLimitPartition.GetTokenBucketLimiter(
        ctx.User.FindFirst("sub")?.Value ?? ctx.Connection.RemoteIpAddress?.ToString() ?? "anon",
        _ => new TokenBucketRateLimiterOptions { TokenLimit = 20, TokensPerPeriod = 20, ReplenishmentPeriod = TimeSpan.FromMinutes(1), QueueLimit = 0 }));
});

// L'application Savoire lit le catalogue et telecharge les paquets depuis son
// propre domaine : origines permises dans Store:AppOrigins. Sans jeton ni
// cookie (les ecritures portent un jeton Bearer).
builder.Services.AddCors();
builder.Services.AddOptions<Microsoft.AspNetCore.Cors.Infrastructure.CorsOptions>().Configure<IConfiguration>((o, config) =>
    o.AddPolicy("app", p => p.WithOrigins(config.GetSection("Store:AppOrigins").Get<string[]>() ?? [])
        .WithMethods("GET", "POST", "PUT", "DELETE").WithHeaders("Authorization", "Content-Type", "Accept")
        .WithExposedHeaders("X-Savoire-Signature", "X-Savoire-Sha256", "X-Savoire-Key-Id")));

// Paquets compresses (gzip) : une Bible en paquet de notes fait ~10 Mio de JSON.
// Seulement sur la route de telechargement (contenu public, sans secret).
builder.Services.AddResponseCompression(o =>
{
    o.EnableForHttps = true;
    o.MimeTypes = ["application/json"];
});

// Derriere Caddy : adresse du visiteur (limites), protocole et hote d'origine (liens).
builder.Services.Configure<Microsoft.AspNetCore.Builder.ForwardedHeadersOptions>(o =>
{
    o.ForwardedHeaders = Microsoft.AspNetCore.HttpOverrides.ForwardedHeaders.XForwardedFor
        | Microsoft.AspNetCore.HttpOverrides.ForwardedHeaders.XForwardedProto
        | Microsoft.AspNetCore.HttpOverrides.ForwardedHeaders.XForwardedHost;
    o.KnownNetworks.Clear();
    o.KnownProxies.Clear();
});

WebApplication app = builder.Build();

using (IServiceScope scope = app.Services.CreateScope())
{
    await scope.ServiceProvider.GetRequiredService<StoreDb>().Database.MigrateAsync();
    _ = scope.ServiceProvider.GetRequiredService<PackageSigner>(); // une cle absente arrete le demarrage
    // Developpement seulement : un catalogue de demonstration (Store:DemoSeed).
    if (app.Environment.IsDevelopment() && app.Configuration.GetValue("Store:DemoSeed", false))
        await DemoSeed.RunAsync(scope.ServiceProvider, app.Configuration["Store:DemoImages"]);
}

if (app.Configuration.GetValue("ForwardedHeaders:Enabled", false)) app.UseForwardedHeaders();
// Sous l'adresse de Savoire (pas encore de domaine) : https://savoire.../store/...
if (app.Configuration["Store:PathBase"] is { Length: > 1 } pathBase) app.UsePathBase(pathBase.TrimEnd('/'));
app.Use((ctx, next) => { SitePages.Base = ctx.Request.PathBase.Value ?? ""; return next(); });

app.Use(async (ctx, next) =>
{
    try { await next(); }
    catch (PublishException ex) when (!ctx.Response.HasStarted)
    {
        await Errors.Of(ex.Status, ex.Code, ex.Message).ExecuteAsync(ctx);
    }
    catch (UnauthorizedAccessException) when (!ctx.Response.HasStarted)
    {
        await Errors.Of(401, "unauthorized", "Compte Savoire requis.").ExecuteAsync(ctx);
    }
});
app.UseWhen(ctx => ctx.Request.Path.StartsWithSegments("/api/v1/items") && ctx.Request.Path.Value!.EndsWith("/download", StringComparison.Ordinal),
    b => b.UseResponseCompression());
app.UseCors("app");
app.UseAuthentication();
app.UseAuthorization();
app.UseRateLimiter();

app.MapGet("/health/live", () => Results.Ok(new { status = "live" }));
app.MapGet("/health/ready", async (StoreDb db, CancellationToken ct) =>
    await db.Database.CanConnectAsync(ct) ? Results.Ok(new { status = "ready" }) : Results.Json(new { status = "database-unreachable" }, statusCode: 503));

CatalogEndpoints.Map(app);
ReviewEndpoints.Map(app);
PublishEndpoints.Map(app);

// Le site.
SiteAuth.Map(app);
SiteRoutes.Map(app);

app.Run();

public partial class Program
{
    public const string WritesPolicy = "writes";
}
