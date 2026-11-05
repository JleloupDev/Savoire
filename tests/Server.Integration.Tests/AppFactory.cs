// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// WebApplicationFactory pour les tests d'intégration.
// Remplace les stores par des implémentations de test : une base PostgreSQL
// neuve par factory (supprimee a la fin) et un dossier temporaire.
// Serveur : SAVOIRE_TEST_POSTGRES, sinon le PostgreSQL de dev
// (deploy/compose/docker-compose.dev.yml), avec un role qui cree des bases.
// see ADR-019

using System.IdentityModel.Tokens.Jwt;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Security.Cryptography;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;
using Microsoft.IdentityModel.Tokens;
using Npgsql;

namespace Savoire.Server.Integration.Tests;

public class AppFactory : WebApplicationFactory<Program>
{
    // Administrateur : son adresse est dans Auth:AdminEmails.
    public const string AdminEmail    = "admin@test.local";
    public const string AdminSubject  = "admin-test-subject";

    // Fournisseur d'identite de test (ADR-028) : une cle RSA propre au
    // processus ; les jetons des comptes sont signes ici, comme par Zitadel.
    public const string IdpIssuer   = "https://idp.test";
    public const string IdpAudience = "savoire-test-project";
    private static readonly RsaSecurityKey IdpKey = new(RSA.Create(2048)) { KeyId = "test-key" };

    // Jetons signes par Savoire (liens de partage, vues integrees).
    public const string JwtSecret   = "test-secret-key-for-tests-minimum-32-chars!!";
    public const string JwtIssuer   = "vault-server";
    public const string JwtAudience = "vault-client";

    // Dossier temporaire isolé par instance de factory (un par classe de test)
    public string TempStoragePath { get; } =
        Path.Combine(Path.GetTempPath(), "poc-tests", Guid.NewGuid().ToString("N"));

    /// <summary>Serveur PostgreSQL des tests (sans base).</summary>
    public static string TestServer =>
        Environment.GetEnvironmentVariable("SAVOIRE_TEST_POSTGRES")
        ?? "Host=127.0.0.1;Port=5432;Username=postgres;Password=postgres";

    /// <summary>Base propre a cette factory, creee par les migrations au demarrage.</summary>
    public string DatabaseName { get; } = "savoire_test_" + Guid.NewGuid().ToString("N");

    public string ConnectionString =>
        new NpgsqlConnectionStringBuilder(TestServer) { Database = DatabaseName }.ConnectionString;

    public AppFactory()
    {
        if (Directory.Exists(TempStoragePath))
        {
            try { Directory.Delete(TempStoragePath, recursive: true); }
            catch { TempStoragePath = Path.Combine(Path.GetTempPath(), "poc-tests", Guid.NewGuid().ToString("N")); }
        }
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        Directory.CreateDirectory(TempStoragePath);
        // Jamais le fichier de bootstrap.mjs du poste de dev.
        builder.UseSetting("Savoire:OidcConfigFile", "");

        builder.ConfigureAppConfiguration(config =>
        {
            config.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Storage:Root"]        = TempStoragePath,
                ["ConnectionStrings:Savoire"] = ConnectionString,
                // JWT
                ["Jwt:Secret"]                       = JwtSecret,
                ["Jwt:Issuer"]                       = JwtIssuer,
                ["Jwt:Audience"]                     = JwtAudience,
                // Fournisseur d'identite (cles fournies plus bas, sans reseau)
                ["Auth:Oidc:Authority"]   = IdpIssuer,
                ["Auth:Oidc:Audience"]    = IdpAudience,
                ["Auth:Oidc:WebClientId"] = "web-test-client",
                ["Auth:Oidc:DesktopClientId"] = "desktop-test-client",
                ["Auth:AdminEmails:0"]    = AdminEmail,
            });
        });

        // Les cles de l'IdP de test, au lieu de les chercher a son adresse.
        builder.ConfigureTestServices(services =>
            services.PostConfigure<JwtBearerOptions>("oidc", o =>
            {
                o.ConfigurationManager = null;
                var configuration = new OpenIdConnectConfiguration { Issuer = IdpIssuer };
                configuration.SigningKeys.Add(IdpKey);
                o.Configuration = configuration;
                o.TokenValidationParameters.ValidIssuer = IdpIssuer;
                o.TokenValidationParameters.ValidAudience = IdpAudience;
                o.TokenValidationParameters.IssuerSigningKey = IdpKey;
            }));
    }

    /// <summary>
    /// Un jeton d'acces de l'IdP de test. Par defaut, comme Zitadel : pas
    /// d'adresse dans le jeton ; on la met ici pour que le compte la recoive
    /// a sa creation (pas d'appel userinfo dans les tests).
    /// </summary>
    public static string MintIdpToken(
        string subject, string? email, string? name = null, bool emailVerified = true,
        DateTime? expires = null, string issuer = IdpIssuer, string audience = IdpAudience, SecurityKey? key = null)
    {
        var claims = new List<Claim> { new("sub", subject), new("jti", Guid.NewGuid().ToString()) };
        if (email is not null)
        {
            claims.Add(new Claim("email", email));
            claims.Add(new Claim("email_verified", emailVerified ? "true" : "false"));
        }
        if (name is not null) claims.Add(new Claim("name", name));
        DateTime exp = expires ?? DateTime.UtcNow.AddMinutes(30);
        var token = new JwtSecurityToken(
            issuer: issuer,
            audience: audience,
            claims: claims,
            notBefore: exp.AddHours(-1),
            expires: exp,
            signingCredentials: new SigningCredentials(key ?? IdpKey, SecurityAlgorithms.RsaSha256));
        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    /// <summary>Retourne un HttpClient avec le token admin en Authorization: Bearer.</summary>
    public async Task<HttpClient> CreateAdminClientAsync()
    {
        var token = await GetAdminTokenAsync();
        var client = CreateClient();
        client.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", token);
        return client;
    }

    /// <summary>Jeton de l'administrateur ; son compte est cree a la premiere requete.</summary>
    public Task<string> GetAdminTokenAsync() =>
        Task.FromResult(MintIdpToken(AdminSubject, AdminEmail, "Test Admin"));

    /// <summary>
    /// Inscrit un nouveau document dans un vault, comme le fait le client
    /// avant de le creer : en mode serveur, un document inconnu du registre
    /// « document -> vault » est refuse.
    /// </summary>
    public async Task<string> NewDocumentAsync(string token, string vaultId)
    {
        string docId = Guid.NewGuid().ToString();
        await using var conn = new HubConnectionBuilder()
            .WithUrl("http://localhost/hubs/vault", options =>
            {
                options.HttpMessageHandlerFactory = _ => Server.CreateHandler();
                options.Transports = HttpTransportType.LongPolling;
                options.AccessTokenProvider = () => Task.FromResult<string?>(token);
            })
            .Build();
        await conn.StartAsync();
        string[] rejected = await conn.InvokeAsync<string[]>("RegisterDocuments", vaultId, new[] { docId });
        if (rejected.Length > 0) throw new InvalidOperationException($"inscription refusee : {docId}");
        return docId;
    }

    /// <summary>
    /// Un compte neuf : un sujet neuf chez l'IdP de test, dont le compte
    /// Savoire est cree par une premiere requete (GET /api/v1/auth/me).
    /// Rend son jeton et son id.
    /// </summary>
    public async Task<(string token, string userId)> CreateUserAndGetTokenAsync(
        string email, string displayName = "Test User 2")
    {
        string token = MintIdpToken("user-" + Guid.NewGuid().ToString("N"), email, displayName);
        var client = CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var me = await client.GetFromJsonAsync<UserInfo>("/api/v1/auth/me")
            ?? throw new InvalidOperationException("Reponse /auth/me vide.");
        return (token, me.Id);
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);

        if (!disposing) return;
        DropDatabase();
        if (Directory.Exists(TempStoragePath))
        {
            try { Directory.Delete(TempStoragePath, recursive: true); }
            catch { /* fichiers encore ouverts : le dossier temporaire est nettoye plus tard */ }
        }
    }

    private void DropDatabase()
    {
        try
        {
            using var conn = new NpgsqlConnection(
                new NpgsqlConnectionStringBuilder(TestServer) { Database = "postgres", Pooling = false }.ConnectionString);
            conn.Open();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = $"DROP DATABASE IF EXISTS \"{DatabaseName}\" WITH (FORCE)";
            cmd.ExecuteNonQuery();
        }
        catch { /* serveur arrete : rien a nettoyer */ }
    }

    // DTO interne pour lire /api/v1/auth/me
    private record UserInfo(string Id, string DisplayName, string Email, bool IsAdmin);
}
