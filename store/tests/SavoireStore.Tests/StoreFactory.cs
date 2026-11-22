// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Un store de test : une base PostgreSQL neuve (supprimee a la fin), un
// fournisseur d'identite de test (cle RSA du processus, comme Zitadel), une
// cle de signature jetable et un faux GitHub.
using System.Collections.Concurrent;
using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;
using Microsoft.IdentityModel.Tokens;
using Npgsql;
using SavoireStore.Publishing;

namespace SavoireStore.Tests;

/// <summary>Faux GitHub : des depots, chacun avec sa derniere release.</summary>
public sealed class FakeGitHub : HttpMessageHandler
{
    public sealed record FakeRelease(string Tag, Dictionary<string, string> Files, Dictionary<string, byte[]>? Binary = null);

    public ConcurrentDictionary<string, FakeRelease> Releases { get; } = new(StringComparer.OrdinalIgnoreCase);

    public void Release(string repo, string tag, Dictionary<string, string> files, Dictionary<string, byte[]>? binary = null) =>
        Releases[repo] = new FakeRelease(tag, files, binary);

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        Uri u = request.RequestUri!;
        if (u.Host == "api.github.com" && u.AbsolutePath.EndsWith("/releases/latest"))
        {
            string repo = u.AbsolutePath["/repos/".Length..^"/releases/latest".Length];
            if (!Releases.TryGetValue(repo, out FakeRelease? r)) return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
            var body = new
            {
                tag_name = r.Tag,
                html_url = $"https://github.com/{repo}/releases/tag/{r.Tag}",
                assets = r.Files.Select(f => (f.Key, Size: (long)Encoding.UTF8.GetByteCount(f.Value)))
                    .Concat((r.Binary ?? []).Select(f => (f.Key, Size: (long)f.Value.Length)))
                    .Select(f => new { name = f.Key, size = f.Size, browser_download_url = $"https://github.com/{repo}/releases/download/{r.Tag}/{f.Key}" }),
            };
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json") });
        }
        if (u.Host == "github.com" && u.AbsolutePath.Contains("/releases/download/"))
        {
            string[] parts = u.AbsolutePath.Trim('/').Split('/');
            string repo = parts[0] + "/" + parts[1];
            if (Releases.TryGetValue(repo, out FakeRelease? r) && r.Files.TryGetValue(parts[^1], out string? text))
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(text) });
            if (r?.Binary is not null && r.Binary.TryGetValue(parts[^1], out byte[]? bytes))
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(bytes) });
        }
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
    }
}

public class StoreFactory : WebApplicationFactory<Program>
{
    public const string Issuer = "https://idp.test";
    public const string Audience = "savoire-test-project";
    public const string AdminSubject = "admin-subject";
    private static readonly RsaSecurityKey IdpKey = new(RSA.Create(2048)) { KeyId = "test-key" };

    public FakeGitHub GitHub { get; } = new();
    public string DatabaseName { get; } = "store_test_" + Guid.NewGuid().ToString("N");
    public string KeyFile { get; } = Path.Combine(Path.GetTempPath(), "store-tests", Guid.NewGuid().ToString("N"), "key.pem");

    public static string TestServer =>
        Environment.GetEnvironmentVariable("SAVOIRE_TEST_POSTGRES") ?? "Host=127.0.0.1;Port=5432;Username=postgres;Password=postgres";

    public const string AppOrigin = "https://app.savoire.test";

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");
        builder.ConfigureAppConfiguration(c => c.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Store"] = new NpgsqlConnectionStringBuilder(TestServer) { Database = DatabaseName }.ConnectionString,
            ["Auth:Authority"] = Issuer,
            ["Auth:Audience"] = Audience,
            ["Store:SigningKeyFile"] = KeyFile,
            ["Store:CreateSigningKey"] = "true",
            ["Store:AdminSubjects:0"] = AdminSubject,
            ["Store:AppOrigins:0"] = AppOrigin,
        }));
        builder.ConfigureTestServices(services =>
        {
            services.PostConfigure<JwtBearerOptions>(JwtBearerDefaults.AuthenticationScheme, o =>
            {
                o.ConfigurationManager = null;
                var configuration = new OpenIdConnectConfiguration { Issuer = Issuer };
                configuration.SigningKeys.Add(IdpKey);
                o.Configuration = configuration;
                o.TokenValidationParameters.ValidIssuer = Issuer;
                o.TokenValidationParameters.ValidAudience = Audience;
                o.TokenValidationParameters.IssuerSigningKey = IdpKey;
            });
            services.AddHttpClient(GitHubReleases.HttpClientName).ConfigurePrimaryHttpMessageHandler(() => GitHub);
        });
    }

    public static string Token(string subject, string name)
    {
        var token = new JwtSecurityToken(Issuer, Audience,
            [new Claim("sub", subject), new Claim("name", name)],
            DateTime.UtcNow.AddMinutes(-1), DateTime.UtcNow.AddMinutes(30),
            new SigningCredentials(IdpKey, SecurityAlgorithms.RsaSha256));
        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    public HttpClient As(string subject, string name = "Quelqu'un")
    {
        HttpClient c = CreateClient();
        c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", Token(subject, name));
        return c;
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (!disposing) return;
        NpgsqlConnection.ClearAllPools();
        using var conn = new NpgsqlConnection(TestServer);
        conn.Open();
        using var cmd = new NpgsqlCommand($"DROP DATABASE IF EXISTS \"{DatabaseName}\" WITH (FORCE)", conn);
        cmd.ExecuteNonQuery();
        try { Directory.Delete(Path.GetDirectoryName(KeyFile)!, true); } catch { }
    }
}
