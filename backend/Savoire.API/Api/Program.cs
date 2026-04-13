// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Program.cs — Server.Api — Clean Architecture with MediatR + JWT Auth.
// AssemblyName = Savoire.Server kept for WebApplicationFactory<Program>.

using System.Reflection;
using FluentValidation;
using MediatR;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.OpenApi.Models;
using Savoire.Application.Behaviors;
using Savoire.Application.Common;
using Savoire.Application.Vaults.CreateVault;
using Savoire.Domain.Entities;
using Savoire.Infrastructure.Persistence;
using Savoire.Server.Hubs;
using Savoire.Server.Middleware;

WebApplicationBuilder builder = WebApplication.CreateBuilder(args);

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
builder.Services.AddSignalR();
builder.Services.AddSingleton<Savoire.Application.Sync.Common.IndexOpSequencer>();

// 7. CORS — configurable via AllowedOrigins, fallback permissif en dev
builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
    {
        string[]? allowedOrigins = builder.Configuration
            .GetSection("AllowedOrigins")
            .Get<string[]>();

        if (allowedOrigins is { Length: > 0 })
        {
            policy.WithOrigins(allowedOrigins)
                  .AllowAnyMethod()
                  .AllowAnyHeader()
                  .AllowCredentials();
        }
        else
        {
            // TODO: restrict allowed origins before production — see GitHub issue "CORS: restrict dev fallback"
            policy.SetIsOriginAllowed(_ => true)
                  .AllowAnyHeader()
                  .AllowAnyMethod()
                  .AllowCredentials();
        }
    });
});

WebApplication app = builder.Build();

// Run EF migrations + seed admin on startup
using (IServiceScope scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

    try
    {
        await db.Database.MigrateAsync();
    }
    catch (Microsoft.Data.Sqlite.SqliteException ex) when (ex.Message.Contains("already exists"))
    {
        await db.Database.EnsureDeletedAsync();
        await db.Database.MigrateAsync();
    }

    await SeedAdminAsync(scope.ServiceProvider);

    // Seed "default" vault for backwards compatibility (idempotent)
    db.Database.ExecuteSqlRaw("PRAGMA journal_mode=WAL;");
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

app.MapControllers();
app.MapHub<SyncHub>("/hubs/sync");
app.MapHub<VaultHub>("/hubs/vault");
app.MapHub<DocumentRoomHub>("/hubs/room");
// DocumentHub removed — legacy hub replaced by VaultHub (MediatR)

app.Run();

static async Task SeedAdminAsync(IServiceProvider services)
{
    var userManager = services.GetRequiredService<UserManager<AppUser>>();
    var config = services.GetRequiredService<IConfiguration>();
    var env = services.GetRequiredService<Microsoft.Extensions.Hosting.IHostEnvironment>();

    var email = config["Admin:Email"];
    var password = config["Admin:Password"];

    if (string.IsNullOrEmpty(email) || string.IsNullOrEmpty(password))
    {
        if (!env.IsDevelopment())
            return;

        email ??= "admin@local.dev";
        password ??= "Admin1234!";
    }

    if (await userManager.FindByEmailAsync(email) is not null) return;

    var admin = new AppUser
    {
        UserName      = email,
        Email         = email,
        DisplayName   = config["Admin:DisplayName"] ?? "Admin",
        IsAdmin       = true,
        EmailConfirmed = true
    };

    var result = await userManager.CreateAsync(admin, password);
    if (!result.Succeeded)
        throw new InvalidOperationException(
            $"Admin seed failed: {string.Join(", ", result.Errors.Select(e => e.Description))}");
}

// Accessible to WebApplicationFactory in integration tests
public partial class Program { }
