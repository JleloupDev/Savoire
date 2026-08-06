// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// DI extensions for the Infrastructure layer — called from the Api's Program.cs.

using System.Text;
using Azure.Storage.Blobs;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.IdentityModel.Tokens;
using Savoire.Application.Abstractions;
using Savoire.Domain.Entities;
using Savoire.Domain.Interfaces;
using Savoire.Domain.Repositories;
using Savoire.Domain.Services;
using Savoire.Infrastructure.Auth;
using Savoire.Infrastructure.Persistence.Repositories;
using Savoire.Infrastructure.Storage;

namespace Savoire.Infrastructure.Persistence;

public static class ServiceCollectionExtensions
{
    public static IServiceCollection AddInfrastructure(
        this IServiceCollection services, IConfiguration config)
    {
        string rawRoot     = config.GetValue<string>("Storage:Root") ?? "storage";
        string storageRoot = Path.IsPathRooted(rawRoot)
            ? rawRoot
            : Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, rawRoot));

        string rawDbPath = config.GetValue<string>("Database:Path") ?? Path.Combine(storageRoot, "metadata.db");
        string dbPath = Path.IsPathRooted(rawDbPath)
            ? rawDbPath
            : Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, rawDbPath));

        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(dbPath))!);
        Directory.CreateDirectory(storageRoot);

        // EF Core
        services.AddDbContext<AppDbContext>(o => o.UseSqlite($"Data Source={dbPath}"));

        services.AddIdentityCore<AppUser>(options =>
        {
            options.Password.RequiredLength = 10;
            options.Password.RequireDigit = true;
            options.Password.RequireUppercase = false;
            options.Password.RequireNonAlphanumeric = false;
            options.SignIn.RequireConfirmedEmail = false;
            options.Lockout.MaxFailedAccessAttempts = 5;
            options.Lockout.DefaultLockoutTimeSpan = TimeSpan.FromMinutes(15);
        })
        .AddRoles<IdentityRole>()
        .AddSignInManager()
        .AddEntityFrameworkStores<AppDbContext>()
        .AddDefaultTokenProviders();

        // JWT
        services
            .AddAuthentication(options =>
            {
                options.DefaultAuthenticateScheme = JwtBearerDefaults.AuthenticationScheme;
                options.DefaultChallengeScheme = JwtBearerDefaults.AuthenticationScheme;
                options.DefaultScheme = JwtBearerDefaults.AuthenticationScheme;
            })
            .AddJwtBearer(options =>
            {
                options.MapInboundClaims = false;
                options.TokenValidationParameters = new TokenValidationParameters
                {
                    ValidateIssuerSigningKey = true,
                    // Dynamic resolution: reads from IConfiguration on every validation
                    IssuerSigningKeyResolver = (_, _, _, _) =>
                    {
                        var secret = config["Jwt:Secret"]
                            ?? throw new InvalidOperationException("Jwt:Secret manquant.");
                        return [new SymmetricSecurityKey(Encoding.UTF8.GetBytes(secret))];
                    },
                    ValidateIssuer = true,
                    ValidIssuer = config["Jwt:Issuer"] ?? "vault-server",
                    ValidateAudience = true,
                    ValidAudience = config["Jwt:Audience"] ?? "vault-client",
                    ValidateLifetime = true,
                    ClockSkew = TimeSpan.FromSeconds(30)
                };

                // SignalR: token from query string
                options.Events = new JwtBearerEvents
                {
                    OnMessageReceived = context =>
                    {
                        var token = context.Request.Query["access_token"];
                        if (!string.IsNullOrEmpty(token) &&
                            context.HttpContext.Request.Path.StartsWithSegments("/hubs"))
                            context.Token = token;
                        return Task.CompletedTask;
                    }
                };
            });

        services.AddAuthorization(options =>
        {
            options.AddPolicy("AdminOnly",
                policy => policy.RequireClaim("is_admin", "true"));
        });

        // Content store — same code, different target depending on the injected connection string
        // Locally: Azurite (via Aspire)
        // In prod: real Azure Blob Storage (via Aspire/azd)
        // Fallback: filesystem when no connection string is present (tests, CI without Azure)
        var blobConnectionString = config.GetConnectionString("vault-files");

        if (!string.IsNullOrEmpty(blobConnectionString))
        {
            var blobServiceClient = new BlobServiceClient(blobConnectionString);
            var store = new AzureBlobContentStore(blobServiceClient, "vaults");

            services.AddSingleton<IContentStore>(store);
            services.AddSingleton<IHostedService>(_ => new BlobContainerInitializer(store));
        }
        else
        {
            // see ADR-020
            services.AddSingleton<IContentStore>(_ => new LocalFileContentStore(storageRoot));
        }

        // Existing repositories (scoped — depend on DbContext)
        services.AddScoped<IVaultRepository,     EfVaultRepository>();
        services.AddScoped<IFolderRepository, EfFolderRepository>();
        services.AddScoped<ICrdtOpRepository, EfCrdtOpRepository>();

        // Auth repositories
        services.AddScoped<IRefreshTokenRepository, RefreshTokenRepository>();

        // Sharing repositories
        services.AddScoped<IResourcePermissionRepository, EfResourcePermissionRepository>();
        services.AddScoped<IShareLinkRepository,           EfShareLinkRepository>();

        // Index repositories
        services.AddScoped<IIndexSnapshotRepository,  EfIndexSnapshotRepository>();

        // Edgesync blob repository (blind per-vault backup store, see ADR-022-style stance)
        services.AddScoped<IEdgesyncBlobRepository, EfEdgesyncBlobRepository>();

        // Vault key escrow (blind per-user key wraps — S3, see VaultKeyEscrow.ts)
        services.AddScoped<IVaultKeyWrapRepository, EfVaultKeyWrapRepository>();

        // Managed vault keyring (server-held Keyring in clear — S2, per vault, see ManagedVaultKeyringSource.ts)
        services.AddScoped<IManagedVaultKeyringRepository, EfManagedVaultKeyringRepository>();

        // Domain Auth services
        services.AddScoped<ITokenService,      TokenService>();
        services.AddScoped<IUserService,       IdentityUserService>();

        // User lookup service backed by ASP.NET Identity (replaces the static ConfigUserService)
        services.AddScoped<IUserLookupService, IdentityUserLookupService>();

        return services;
    }
}
