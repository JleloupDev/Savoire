// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Tests unitaires : origines acceptees par CORS (web, application de bureau, dev).

using FluentAssertions;
using Microsoft.Extensions.Configuration;
using Savoire.Server.Extensions;

namespace Savoire.Server.Unit.Tests.Cors;

public class CorsOriginsTests
{
    private static IConfiguration Config(params (string Key, string Value)[] values) =>
        new ConfigurationBuilder()
            .AddInMemoryCollection(values.Select(v => new KeyValuePair<string, string?>(v.Key, v.Value)))
            .Build();

    [Theory]
    [InlineData("tauri://localhost")]
    [InlineData("http://tauri.localhost")]
    [InlineData("https://tauri.localhost")]
    public void Desktop_origins_are_accepted_by_default(string origin)
    {
        var rule = CorsOrigins.Rule(Config(("AllowedOrigins:0", "https://savoire.example.org")), isDevelopment: false);
        rule(origin).Should().BeTrue();
    }

    [Fact]
    public void Configured_web_origin_is_accepted_and_unknown_is_refused()
    {
        var rule = CorsOrigins.Rule(Config(("AllowedOrigins:0", "https://savoire.example.org/")), isDevelopment: true);
        rule("https://savoire.example.org").Should().BeTrue();
        rule("https://evil.example").Should().BeFalse();
        // Liste web explicite : les adresses locales ne passent plus, meme en dev.
        rule("http://127.0.0.1:3002").Should().BeFalse();
    }

    [Fact]
    public void Nothing_configured_refuses_every_web_origin_outside_development()
    {
        var rule = CorsOrigins.Rule(Config(), isDevelopment: false);
        rule("https://evil.example").Should().BeFalse();
        rule("http://localhost:3000").Should().BeFalse();
        rule("tauri://localhost").Should().BeTrue();
    }

    [Fact]
    public void Nothing_configured_in_development_accepts_only_loopback()
    {
        var rule = CorsOrigins.Rule(Config(), isDevelopment: true);
        rule("http://localhost:3000").Should().BeTrue();
        rule("http://127.0.0.1:3002").Should().BeTrue();
        rule("http://[::1]:5173").Should().BeTrue();
        rule("https://evil.example").Should().BeFalse();
        rule("http://192.168.1.10:3000").Should().BeFalse();
        rule("null").Should().BeFalse();
    }

    [Fact]
    public void Empty_desktop_list_refuses_the_desktop_app()
    {
        // Une liste vide se configure en variable d'environnement par une valeur vide.
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["DesktopAppOrigins"] = "" })
            .Build();
        var rule = CorsOrigins.Rule(config, isDevelopment: false);
        rule("tauri://localhost").Should().BeFalse();
    }

    [Fact]
    public void Custom_desktop_list_replaces_the_defaults()
    {
        var rule = CorsOrigins.Rule(Config(("DesktopAppOrigins:0", "tauri://localhost")), isDevelopment: false);
        rule("tauri://localhost").Should().BeTrue();
        rule("http://tauri.localhost").Should().BeFalse();
    }
}
