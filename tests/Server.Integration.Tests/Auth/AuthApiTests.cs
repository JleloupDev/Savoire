// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Tests d'intégration — connexion par le fournisseur d'identite (ADR-028).
// Couvre : configuration publique, compte cree a la premiere requete,
// administrateurs par adresse, jetons refuses (emetteur, signature, audience,
// expiration, adresse non verifiee).

using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.IdentityModel.Tokens;
using Savoire.Application.Auth.DTOs;
using Savoire.Domain.Interfaces;

namespace Savoire.Server.Integration.Tests.Auth;

[Collection("Integration")]
public class AuthApiTests : IClassFixture<AppFactory>
{
    private readonly AppFactory _factory;

    public AuthApiTests(AppFactory factory)
    {
        _factory = factory;
    }

    private HttpClient ClientWith(string token)
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return client;
    }

    [Fact]
    public async Task GET_config_IsPublic_AndNamesTheIdentityProvider()
    {
        var response = await _factory.CreateClient().GetAsync("/api/v1/auth/config");

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var config = await response.Content.ReadFromJsonAsync<AuthConfigDto>();
        config!.Issuer.Should().Be(AppFactory.IdpIssuer);
        config.WebClientId.Should().Be("web-test-client");
        config.DesktopClientId.Should().Be("desktop-test-client");
        config.Scopes.Should().Contain("offline_access");
    }

    [Fact]
    public async Task GET_me_FirstRequest_CreatesTheAccount_FromTheToken()
    {
        string subject = "first-" + Guid.NewGuid().ToString("N");
        string email = $"{subject}@test.local";
        var client = ClientWith(AppFactory.MintIdpToken(subject, email, "Premiere Fois"));

        var me = await client.GetFromJsonAsync<AuthUserDto>("/api/v1/auth/me");

        me!.Id.Should().Be(subject);
        me.Email.Should().Be(email);
        me.DisplayName.Should().Be("Premiere Fois");
        me.IsAdmin.Should().BeFalse();

        // Meme sujet, second jeton : le meme compte, pas un nouveau.
        var again = await ClientWith(AppFactory.MintIdpToken(subject, email, "Premiere Fois"))
            .GetFromJsonAsync<AuthUserDto>("/api/v1/auth/me");
        again!.Id.Should().Be(subject);
    }

    [Fact]
    public async Task GET_me_AdminEmail_Verified_IsAdmin()
    {
        var me = await ClientWith(await _factory.GetAdminTokenAsync())
            .GetFromJsonAsync<AuthUserDto>("/api/v1/auth/me");

        me!.IsAdmin.Should().BeTrue();
    }

    [Fact]
    public async Task GET_me_AdminEmail_NotVerified_IsNotAdmin()
    {
        // Une adresse non verifiee par l'IdP ne donne aucun droit.
        string subject = "unverified-" + Guid.NewGuid().ToString("N");
        var me = await ClientWith(AppFactory.MintIdpToken(subject, AppFactory.AdminEmail, "Usurpateur", emailVerified: false))
            .GetFromJsonAsync<AuthUserDto>("/api/v1/auth/me");

        me!.IsAdmin.Should().BeFalse();
        me.Email.Should().BeEmpty("une adresse non verifiee n'est pas gardee");
    }

    [Fact]
    public async Task GET_me_EmailVerifiedLater_IsPickedUp()
    {
        string subject = "later-" + Guid.NewGuid().ToString("N");
        string email = $"{subject}@test.local";
        var first = await ClientWith(AppFactory.MintIdpToken(subject, email, "Plus Tard", emailVerified: false))
            .GetFromJsonAsync<AuthUserDto>("/api/v1/auth/me");
        first!.Email.Should().BeEmpty();

        // L'etat du compte est garde une minute : on l'oublie, comme a son expiration.
        _factory.Services.GetRequiredService<IAccountCache>().Forget(subject);
        var later = await ClientWith(AppFactory.MintIdpToken(subject, email, "Plus Tard", emailVerified: true))
            .GetFromJsonAsync<AuthUserDto>("/api/v1/auth/me");
        later!.Email.Should().Be(email);
    }

    [Fact]
    public async Task GET_me_WithoutToken_Returns401()
    {
        var response = await _factory.CreateClient().GetAsync("/api/v1/auth/me");
        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    public static TheoryData<string> RejectedTokens()
    {
        string subject = "rejected-" + Guid.NewGuid().ToString("N");
        string email = $"{subject}@test.local";
        var otherKey = new RsaSecurityKey(RSA.Create(2048)) { KeyId = "test-key" };
        return new TheoryData<string>
        {
            AppFactory.MintIdpToken(subject, email, key: otherKey),
            AppFactory.MintIdpToken(subject, email, issuer: "https://autre-idp.test"),
            AppFactory.MintIdpToken(subject, email, audience: "un-autre-projet"),
            AppFactory.MintIdpToken(subject, email, expires: DateTime.UtcNow.AddMinutes(-5)),
        };
    }

    [Theory]
    [MemberData(nameof(RejectedTokens))]
    public async Task GET_me_InvalidToken_Returns401(string token)
    {
        var response = await ClientWith(token).GetAsync("/api/v1/auth/me");
        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task OldPasswordRoutes_AreGone()
    {
        var anon = _factory.CreateClient();
        foreach (string path in new[] { "/api/v1/auth/login", "/api/v1/auth/refresh" })
        {
            var response = await anon.PostAsJsonAsync(path, new { Email = "a@b.c", Password = "x" });
            response.StatusCode.Should().BeOneOf(HttpStatusCode.NotFound, HttpStatusCode.MethodNotAllowed);
        }
    }
}
