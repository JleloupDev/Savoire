// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// WebApplicationFactory pour les tests d'intégration.
// Remplace les stores par des implémentations de test (SQLite fichier temp + dossier temp).
// see ADR-019

using System.Net.Http.Headers;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;

namespace Savoire.Server.Integration.Tests;

public class AppFactory : WebApplicationFactory<Program>
{
    // Credentials admin seedé au démarrage
    public const string AdminEmail    = "admin@test.local";
    public const string AdminPassword = "AdminTest1!";

    // JWT config partagée pour les tests
    public const string JwtSecret   = "test-secret-key-for-tests-minimum-32-chars!!";
    public const string JwtIssuer   = "vault-server";
    public const string JwtAudience = "vault-client";

    // Dossier temporaire isolé par instance de factory (un par classe de test)
    public string TempStoragePath { get; } =
        Path.Combine(Path.GetTempPath(), "poc-tests", Guid.NewGuid().ToString("N"));

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

        builder.ConfigureAppConfiguration(config =>
        {
            config.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Storage:Root"]        = TempStoragePath,
                // JWT
                ["Jwt:Secret"]                       = JwtSecret,
                ["Jwt:Issuer"]                       = JwtIssuer,
                ["Jwt:Audience"]                     = JwtAudience,
                ["Jwt:AccessTokenExpirationMinutes"] = "15",
                ["Jwt:RefreshTokenExpirationDays"]   = "7",
                // Admin seedé au démarrage
                ["Admin:Email"]       = AdminEmail,
                ["Admin:Password"]    = AdminPassword,
                ["Admin:DisplayName"] = "Test Admin"
            });
        });
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

    /// <summary>Retourne le JWT admin (appel POST /api/v1/auth/login).</summary>
    public async Task<string> GetAdminTokenAsync()
    {
        var client = CreateClient();
        var response = await client.PostAsJsonAsync("/api/v1/auth/login",
            new { Email = AdminEmail, Password = AdminPassword });
        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadFromJsonAsync<AuthTokenResponse>()
            ?? throw new InvalidOperationException("Réponse login vide.");
        return body.AccessToken;
    }

    /// <summary>
    /// Crée un utilisateur via l'API admin et retourne son JWT + userId.
    /// </summary>
    public async Task<(string token, string userId)> CreateUserAndGetTokenAsync(
        string email, string password = "TestPass1!", string displayName = "Test User 2")
    {
        var adminClient = await CreateAdminClientAsync();

        // V2 : création directe via POST /admin/users
        var createResp = await adminClient.PostAsJsonAsync(
            "/api/v1/admin/users",
            new { Email = email, Password = password, DisplayName = displayName });
        createResp.EnsureSuccessStatusCode();
        var createdUser = await createResp.Content.ReadFromJsonAsync<UserInfo>()
            ?? throw new InvalidOperationException("Réponse create-user vide.");

        // Login pour obtenir les tokens
        var loginClient = CreateClient();
        var loginResp = await loginClient.PostAsJsonAsync(
            "/api/v1/auth/login",
            new { Email = email, Password = password });
        loginResp.EnsureSuccessStatusCode();
        var authResp = await loginResp.Content.ReadFromJsonAsync<AuthTokenResponse>()
            ?? throw new InvalidOperationException("Réponse login vide.");

        return (authResp.AccessToken, authResp.User.Id);
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);

        if (disposing && Directory.Exists(TempStoragePath))
        {
            GC.Collect();
            GC.WaitForPendingFinalizers();
            System.Threading.Thread.Sleep(100);

            try
            {
                var dbPath = Path.Combine(TempStoragePath, "metadata.db");
                if (File.Exists(dbPath + "-wal")) try { File.Delete(dbPath + "-wal"); } catch { }
                if (File.Exists(dbPath + "-shm")) try { File.Delete(dbPath + "-shm"); } catch { }
                if (File.Exists(dbPath)) try { File.Delete(dbPath); } catch { }
                Directory.Delete(TempStoragePath, recursive: true);
            }
            catch { }
        }
    }

    // DTOs internes pour désérialiser les réponses auth
    private record AuthTokenResponse(string AccessToken, string RefreshToken, int ExpiresIn, UserInfo User);
    private record UserInfo(string Id, string DisplayName, string Email, bool IsAdmin);
}
