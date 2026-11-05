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
if (builder.Configuration["Savoire:OidcConfigFile"] is { Length: > 0 } oidcFile)
{
    string path = Path.IsPathRooted(oidcFile)
        ? oidcFile
        : Path.GetFullPath(Path.Combine(builder.Environment.ContentRootPath, oidcFile));
    builder.Configuration.AddJsonFile(path, optional: true, reloadOnChange: true);
}

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
});
builder.Services.AddScoped<IVaultAccessGuard, VaultAccessGuard>();
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
    o.MaximumReceiveMessageSize = 4 * 1024 * 1024;
});
builder.Services.AddSingleton<Savoire.Server.Hubs.EdgeSyncRooms>();
builder.Services.AddSingleton<Savoire.Server.Hubs.DocumentLockRegistry>();

// 7. CORS : origines web (AllowedOrigins) + application de bureau
// (DesktopAppOrigins, origines Tauri par defaut). Jamais « toutes les
// origines » : voir CorsOrigins.
builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
        Savoire.Server.Extensions.CorsOrigins.Configure(
            policy, builder.Configuration, builder.Environment.IsDevelopment()));
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
app.MapHub<SyncHub>("/hubs/sync");
app.MapHub<VaultHub>("/hubs/vault");
app.MapHub<DocumentRoomHub>("/hubs/room");
app.MapHub<EdgeSyncHub>("/hubs/edgesync");
// DocumentHub removed — legacy hub replaced by VaultHub (MediatR)

app.Run();

// Accessible to WebApplicationFactory in integration tests
public partial class Program { }
