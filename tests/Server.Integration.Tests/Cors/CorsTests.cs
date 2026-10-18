// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Tests d'integration : CORS de l'API et des hubs pour l'application de bureau.

using FluentAssertions;

namespace Savoire.Server.Integration.Tests.Cors;

[Collection("Integration")]
public class CorsTests : IClassFixture<AppFactory>
{
    private readonly AppFactory _factory;

    public CorsTests(AppFactory factory) => _factory = factory;

    private async Task<HttpResponseMessage> PreflightAsync(string path, string origin)
    {
        var client = _factory.CreateClient();
        var req = new HttpRequestMessage(HttpMethod.Options, path);
        req.Headers.Add("Origin", origin);
        req.Headers.Add("Access-Control-Request-Method", "POST");
        req.Headers.Add("Access-Control-Request-Headers", "authorization,content-type");
        return await client.SendAsync(req);
    }

    private static string? AllowedOrigin(HttpResponseMessage res) =>
        res.Headers.TryGetValues("Access-Control-Allow-Origin", out var v) ? v.SingleOrDefault() : null;

    [Theory]
    [InlineData("tauri://localhost")]
    [InlineData("http://tauri.localhost")]
    public async Task Desktop_app_origin_is_accepted_on_api_and_hubs(string origin)
    {
        foreach (var path in new[] { "/api/v1/auth/login", "/hubs/vault/negotiate?negotiateVersion=1" })
        {
            var res = await PreflightAsync(path, origin);
            AllowedOrigin(res).Should().Be(origin, $"preflight {path}");
            res.Headers.TryGetValues("Access-Control-Allow-Credentials", out var cred).Should().BeTrue();
            cred!.Single().Should().Be("true");
        }
    }

    [Fact]
    public async Task Unknown_origin_is_refused()
    {
        var res = await PreflightAsync("/api/v1/auth/login", "https://evil.example");
        AllowedOrigin(res).Should().BeNull();
    }

    [Fact]
    public async Task Actual_request_from_desktop_app_carries_the_cors_header()
    {
        var client = _factory.CreateClient();
        var req = new HttpRequestMessage(HttpMethod.Post, "/api/v1/auth/login")
        {
            Content = System.Net.Http.Json.JsonContent.Create(new { Email = AppFactory.AdminEmail, Password = AppFactory.AdminPassword }),
        };
        req.Headers.Add("Origin", "tauri://localhost");
        var res = await client.SendAsync(req);
        res.IsSuccessStatusCode.Should().BeTrue();
        AllowedOrigin(res).Should().Be("tauri://localhost");
    }
}
