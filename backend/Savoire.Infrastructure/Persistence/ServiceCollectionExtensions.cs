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
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using Microsoft.IdentityModel.Tokens;
using Savoire.Application.Abstractions;
using Savoire.Domain.Entities;
using Savoire.Domain.Interfaces;
using Savoire.Domain.Repositories;
using Savoire.Domain.Services;
using Savoire.Infrastructure.Auth;
using Savoire.Infrastructure.Persistence.Repositories;
using Savoire.Infrastructure.Services;
using Savoire.Infrastructure.Storage;

namespace Savoire.Infrastructure.Persistence;

public static class ServiceCollectionExtensions
{
    public static IServiceCollection AddInfrastructure(
        this IServiceCollection services, IConfiguration config)
    {
        // Lus a la resolution, pas a l'enregistrement : la configuration
        // ajoutee ensuite (tests : WebApplicationFactory) compte aussi.
        static string StorageRoot(IConfiguration c)
        {
            string raw = c.GetValue<string>("Storage:Root") ?? "storage";
            string root = Path.IsPathRooted(raw) ? raw : Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, raw));
            Directory.CreateDirectory(root);
            return root;
        }

        // EF Core sur PostgreSQL (ADR-028). Une seule base pour tout l'etat du
        // serveur ; ConnectionStrings:Savoire, ou ConnectionStrings__Savoire.
        services.AddDbContext<AppDbContext>((sp, o) => o.UseNpgsql(
            sp.GetRequiredService<IConfiguration>().GetConnectionString("Savoire")
            ?? throw new InvalidOperationException(
                "ConnectionStrings:Savoire manquant (PostgreSQL). En dev : deploy/compose/docker-compose.dev.yml.")));

        // Comptes Savoire (ASP.NET Identity, sans mot de passe) : la connexion
        // se fait chez le fournisseur d'identite (ADR-028, AuthenticationSetup).
        services.AddIdentityCore<AppUser>()
            .AddRoles<IdentityRole>()
            .AddEntityFrameworkStores<AppDbContext>();

        services.AddSavoireAuthentication(config);

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
            services.AddSingleton<IContentStore>(sp => new LocalFileContentStore(StorageRoot(sp.GetRequiredService<IConfiguration>())));
        }

        // Existing repositories (scoped — depend on DbContext)
        services.AddScoped<IVaultRepository,     EfVaultRepository>();
        services.AddScoped<IFolderRepository, EfFolderRepository>();
        services.AddScoped<ICrdtOpRepository, EfCrdtOpRepository>();

        // Sharing repositories
        services.AddScoped<IResourcePermissionRepository, EfResourcePermissionRepository>();
        services.AddScoped<IShareLinkRepository,           EfShareLinkRepository>();

        // Index repositories

        // Edgesync blob repository (blind per-vault backup store, see ADR-022-style stance)
        services.AddScoped<IEdgesyncBlobRepository, EfEdgesyncBlobRepository>();
        services.AddScoped<IVaultDocumentRepository, EfVaultDocumentRepository>();

        // Vault key escrow (blind per-user key wraps — S3, see VaultKeyEscrow.ts)
        services.AddScoped<IVaultKeyWrapRepository, EfVaultKeyWrapRepository>();


        // Vault member identities (signPub bridge between ACL and edgesync protocol — see IVaultMemberIdentityRepository)
        services.AddScoped<IVaultMemberIdentityRepository, EfVaultMemberIdentityRepository>();

        // Pair indexeur (ADR-027) : flux de changements, reglage du vault, client de son API.
        // Le delai de chaque appel vient de Indexer:TimeoutMs (HttpIndexerPeerClient).
        services.AddScoped<IIndexerChangeRepository, EfIndexerChangeRepository>();
        services.AddScoped<IVaultIndexerSettingRepository, EfVaultIndexerSettingRepository>();
        services.AddHttpClient(HttpIndexerPeerClient.HttpClientName, c => c.Timeout = Timeout.InfiniteTimeSpan);
        services.AddHttpClient(IndexerServiceTokens.HttpClientName, c => c.Timeout = TimeSpan.FromSeconds(10));
        services.TryAddSingleton(TimeProvider.System);
        services.AddSingleton<IndexerServiceTokens>();
        services.AddSingleton<IIndexerPeerClient, HttpIndexerPeerClient>();

        // Domain Auth services
        services.AddScoped<ITokenService,      TokenService>();
        services.AddScoped<IUserService,       IdentityUserService>();

        // User lookup service backed by ASP.NET Identity (replaces the static ConfigUserService)
        services.AddScoped<IUserLookupService, IdentityUserLookupService>();

        return services;
    }
}
