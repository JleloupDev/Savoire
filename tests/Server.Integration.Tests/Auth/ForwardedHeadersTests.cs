// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Derriere Caddy puis nginx, l'API lit l'hote et le protocole d'origine dans
// les en-tetes X-Forwarded-* (ForwardedHeaders:Enabled). Sans ce reglage,
// elle ne les croit pas : une API joignable directement ne se laisse pas
// dicter son adresse.

using System.Net.Http.Json;
using FluentAssertions;
using Microsoft.AspNetCore.Hosting;

namespace Savoire.Server.Integration.Tests.Auth;

[Collection("Integration")]
public class ForwardedHeadersTests : IClassFixture<AppFactory>
{
    private readonly AppFactory _factory;
    public ForwardedHeadersTests(AppFactory factory) => _factory = factory;

    private static HttpRequestMessage Request()
    {
        var req = new HttpRequestMessage(HttpMethod.Get, "/api/open/v1/openapi.yaml");
        req.Headers.Add("X-Forwarded-Host", "savoire.exemple.fr");
        req.Headers.Add("X-Forwarded-Proto", "https");
        req.Headers.Add("X-Forwarded-For", "203.0.113.7, 172.18.0.2");
        return req;
    }

    [Fact(DisplayName = "Avec le reglage : l'adresse annoncee est celle du visiteur")]
    public async Task Enabled_UsesForwardedHost()
    {
        using var proxied = _factory.WithWebHostBuilder(b => b.UseSetting("ForwardedHeaders:Enabled", "true"));
        string yaml = await (await proxied.CreateClient().SendAsync(Request())).Content.ReadAsStringAsync();
        yaml.Should().Contain("https://savoire.exemple.fr");
    }

    [Fact(DisplayName = "Sans le reglage : les en-tetes ne sont pas crus")]
    public async Task Disabled_IgnoresForwardedHost()
    {
        string yaml = await (await _factory.CreateClient().SendAsync(Request())).Content.ReadAsStringAsync();
        yaml.Should().NotContain("savoire.exemple.fr");
    }
}

[Collection("Integration")]
public class StoreConfigTests : IClassFixture<AppFactory>
{
    private readonly AppFactory _factory;
    public StoreConfigTests(AppFactory factory) => _factory = factory;

    [Fact(DisplayName = "Store : le serveur donne l'adresse et la cle publique du store, sans compte")]
    public async Task StoreConfig()
    {
        using var configured = _factory.WithWebHostBuilder(b => b
            .UseSetting("Store:Url", "/store").UseSetting("Store:PublicKey", "MFkwEw-cle"));
        var json = await configured.CreateClient().GetFromJsonAsync<System.Text.Json.Nodes.JsonObject>("/api/v1/store/config");
        json!["url"]!.GetValue<string>().Should().Be("/store");
        json["publicKey"]!.GetValue<string>().Should().Be("MFkwEw-cle");

        var none = await _factory.CreateClient().GetFromJsonAsync<System.Text.Json.Nodes.JsonObject>("/api/v1/store/config");
        none!["publicKey"].Should().BeNull();
    }
}
