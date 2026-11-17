// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Program.cs — Server.Api — Clean Architecture with MediatR + JWT Auth.
// AssemblyName = Savoire.Server kept for WebApplicationFactory<Program>.

using System.Reflection;
using FluentValidation;
using MediatR;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Microsoft.OpenApi.Models;
using Savoire.Application.Behaviors;
using Savoire.Application.Common;
using Savoire.Application.Vaults.CreateVault;
using Savoire.Domain.Entities;
using Savoire.Infrastructure.Persistence;
using Savoire.Server.Extensions;
using Savoire.Server.Hubs;
using Savoire.Server.Middleware;

WebApplicationBuilder builder = WebApplication.CreateBuilder(args);

// Fournisseur d'identite (ADR-028) : deploy/compose/zitadel/bootstrap.mjs
// ecrit Auth:Oidc et Indexer:Oidc dans un fichier JSON. Savoire:OidcConfigFile
// (ou Savoire__OidcConfigFile) le designe ; relu s'il change.
// Meme mecanisme pour le suivi des erreurs : deploy/compose/glitchtip/bootstrap.py
// ecrit ErrorReporting (Savoire:ErrorReportingConfigFile).
foreach (string key in new[] { "Savoire:OidcConfigFile", "Savoire:ErrorReportingConfigFile" })
{
    if (builder.Configuration[key] is not { Length: > 0 } file) continue;
    string path = Path.IsPathRooted(file)
        ? file
        : Path.GetFullPath(Path.Combine(builder.Environment.ContentRootPath, file));
    builder.Configuration.AddJsonFile(path, optional: true, reloadOnChange: true);
}

// Exploitation : erreurs vers GlitchTip, metriques en OTLP (rien sans reglage).
builder.AddTelemetry();
builder.Services.AddHttpClient("errors", c => c.Timeout = TimeSpan.FromSeconds(10));

// 1. Infrastructure (EF Core, Identity, JWT, repositories, content store)
builder.Services.AddInfrastructure(builder.Configuration);

// 2. MediatR — tous les handlers + ValidationBehavior pour FluentValidation
// see ADR-001
var appAssembly = typeof(CreateVaultCommand).Assembly;
var apiAssembly = typeof(VaultHub).Assembly;
builder.Services.AddMediatR(cfg =>
{
    cfg.RegisterServicesFromAssemblies(appAssembly, apiAssembly);
    cfg.AddBehavior(typeof(IPipelineBehavior<,>), typeof(ValidationBehavior<,>));
    cfg.AddBehavior(typeof(IPipelineBehavior<,>), typeof(VaultAccessBehavior<,>));
    // Apres le controle d'acces : le quota de stockage du proprietaire du vault.
    cfg.AddBehavior(typeof(IPipelineBehavior<,>), typeof(VaultStorageQuotaBehavior<,>));
});
builder.Services.AddScoped<IVaultAccessGuard, VaultAccessGuard>();
builder.Services.AddScoped<AclResolver>();
builder.Services.AddValidatorsFromAssembly(appAssembly);

// Pair indexeur (ADR-027) : configuration « Indexer » et limitation de debit
// de ses routes publiques. Desactive sans Indexer:ServiceToken.
builder.Services.AddIndexer(builder.Configuration);

// 3. Controllers + Problem Details
builder.Services.AddControllers();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddProblemDetails();

// 4. Exception handler global → Problem Details RFC 7807
builder.Services.AddExceptionHandler<DomainExceptionHandler>();

// 5. Swagger / OpenAPI avec Bearer
builder.Services.AddSwaggerGen(options =>
{
    options.SwaggerDoc("v1", new OpenApiInfo
    {
        Title       = "Collaborative Vault API",
        Version     = "v1",
        Description = "Collaborative note sync API with JWT authentication."
    });

    options.AddSecurityDefinition("Bearer", new OpenApiSecurityScheme
    {
        Type        = SecuritySchemeType.Http,
        Scheme      = "bearer",
        BearerFormat = "JWT"
    });

    options.AddSecurityRequirement(new OpenApiSecurityRequirement
    {
        {
            new OpenApiSecurityScheme
            {
                Reference = new OpenApiReference
                {
                    Type = ReferenceType.SecurityScheme,
                    Id   = "Bearer"
                }
            },
            Array.Empty<string>()
        }
    });

    string xmlFile = $"{Assembly.GetExecutingAssembly().GetName().Name}.xml";
    string xmlPath = Path.Combine(AppContext.BaseDirectory, xmlFile);
    if (File.Exists(xmlPath))
        options.IncludeXmlComments(xmlPath);

    options.CustomSchemaIds(type => type.FullName?.Replace("+", "."));
});

// 6. SignalR
// Erreurs des hubs : un code stable (vault-not-found...) plutot que
// « unexpected error ». Voir HubErrorFilter.
// 32 Kio par defaut : trop peu pour l'etat CRDT complet d'un document (envoi
// d'un vault, compaction, gros dessins). 4 Mio reste une borne contre l'abus.
builder.Services.AddSignalR(o =>
{
    o.AddFilter<HubErrorFilter>();
    // Apres HubErrorFilter (qui nomme le refus) : limite d'appels par compte.
    o.AddFilter<HubRateLimitFilter>();
    o.MaximumReceiveMessageSize = 4 * 1024 * 1024;
});
builder.Services.AddSingleton<Savoire.Server.Hubs.EdgeSyncRooms>();
builder.Services.AddSingleton<Savoire.Server.Hubs.DocumentLockRegistry>();
builder.Services.AddSingleton<Savoire.Server.Hubs.HubCallLimiter>();
builder.Services.AddSingleton<Savoire.Server.Hubs.HubSubscriptions>();

// 7. CORS : origines web (AllowedOrigins) + application de bureau
// (DesktopAppOrigins, origines Tauri par defaut). Jamais « toutes les
// origines » : voir CorsOrigins.
builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
        Savoire.Server.Extensions.CorsOrigins.Configure(
            policy, builder.Configuration, builder.Environment.IsDevelopment()));
});

// Derriere Caddy puis nginx (deploy/compose) : l'adresse du visiteur, le
// protocole et l'hote d'origine arrivent dans les en-tetes X-Forwarded-*.
// Sans eux, toutes les requetes semblent venir du proxy : les limites par
// adresse ne distinguent personne, et les pages publiees annoncent l'adresse
// interne. Active seulement par ForwardedHeaders:Enabled : une API joignable
// directement croirait n'importe quel en-tete.
builder.Services.Configure<Microsoft.AspNetCore.Builder.ForwardedHeadersOptions>(o =>
{
    o.ForwardedHeaders = Microsoft.AspNetCore.HttpOverrides.ForwardedHeaders.XForwardedFor
        | Microsoft.AspNetCore.HttpOverrides.ForwardedHeaders.XForwardedProto
        | Microsoft.AspNetCore.HttpOverrides.ForwardedHeaders.XForwardedHost;
    // Deux relais : Caddy, puis nginx.
    o.ForwardLimit = builder.Configuration.GetValue("ForwardedHeaders:ForwardLimit", 2);
    // L'API n'est joignable que par ces relais (reseau interne des conteneurs).
    o.KnownNetworks.Clear();
    o.KnownProxies.Clear();
});

WebApplication app = builder.Build();

// Migrations EF au demarrage. Les comptes viennent du fournisseur d'identite :
// rien a amorcer (administrateurs : Auth:AdminEmails).
using (IServiceScope scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

    // PostgreSQL (ADR-028) : les migrations s'appliquent au demarrage.
    await db.Database.MigrateAsync();


    // Seed "default" vault for backwards compatibility (idempotent)
    if (!db.Vaults.Any(v => v.Id == "default"))
    {
        db.Vaults.Add(new Savoire.Infrastructure.Persistence.VaultEntity
        {
            Id        = "default",
            Name      = "Default Vault",
            OwnerId   = "system",
            CreatedAt = DateTime.UtcNow
        });
        db.SaveChanges();
    }
}

// Pipeline — ordre obligatoire
if (app.Configuration.GetValue("ForwardedHeaders:Enabled", false)) app.UseForwardedHeaders();
app.UseExceptionHandler();
app.UseCors();
app.UseAuthentication();
app.UseAuthorization();
// Apres l'authentification : le debit se compte par personne (et par vault).
app.UseRateLimiter();
// DECISION V2: UserValidationMiddleware (X-User-Id) removed — auth via JWT only.

app.UseSwagger();
app.UseSwaggerUI(options =>
{
    options.SwaggerEndpoint("/swagger/v1/swagger.json", "Collaborative Vault API v1");
    options.RoutePrefix = "swagger";
    options.DisplayRequestDuration();
    options.EnableTryItOutByDefault();
});

app.MapGet("/openapi.yaml", async context =>
{
    string yamlPath = Path.Combine(AppContext.BaseDirectory, "openapi.yaml");
    if (!File.Exists(yamlPath)) { context.Response.StatusCode = 404; return; }
    context.Response.ContentType = "application/yaml";
    await context.Response.SendFileAsync(yamlPath);
});

// Sante (conteneurs, proxy) : vivant, et pret (base joignable).
app.MapGet("/health/live", () => Results.Ok(new { status = "live" })).AllowAnonymous();
app.MapGet("/health/ready", async (AppDbContext db, CancellationToken ct) =>
    await db.Database.CanConnectAsync(ct)
        ? Results.Ok(new { status = "ready" })
        : Results.Json(new { status = "database-unreachable" }, statusCode: 503)).AllowAnonymous();

app.MapControllers();
// Une connexion temps reel ne survit pas a son jeton : a l'expiration, le
// serveur la ferme ; le client se reconnecte avec un jeton neuf, et ses
// droits sont reverifies (M7).
static void CloseAtExpiry(Microsoft.AspNetCore.Http.Connections.HttpConnectionDispatcherOptions o) => o.CloseOnAuthenticationExpiration = true;
app.MapHub<SyncHub>("/hubs/sync", CloseAtExpiry);
app.MapHub<VaultHub>("/hubs/vault", CloseAtExpiry);
app.MapHub<DocumentRoomHub>("/hubs/room", CloseAtExpiry);
app.MapHub<EdgeSyncHub>("/hubs/edgesync", CloseAtExpiry);
// DocumentHub removed — legacy hub replaced by VaultHub (MediatR)

app.Run();

// Accessible to WebApplicationFactory in integration tests
public partial class Program { }
