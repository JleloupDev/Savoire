// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Tests d'intégration — API Auth
// Couvre : login, refresh, logout, change-password

using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using FluentAssertions;
using Savoire.Application.Auth.DTOs;

namespace Savoire.Server.Integration.Tests.Auth;

[Collection("Integration")]
public class AuthApiTests : IClassFixture<AppFactory>
{
    private readonly AppFactory  _factory;
    private readonly HttpClient  _anon;   // client sans auth

    public AuthApiTests(AppFactory factory)
    {
        _factory = factory;
        _anon    = factory.CreateClient();
    }

    // ──────────────────────────────────────────────────────────────────
    // LOGIN
    // ──────────────────────────────────────────────────────────────────

    [Fact]
    public async Task POST_login_WithValidCredentials_Returns200WithTokens()
    {
        var response = await _anon.PostAsJsonAsync("/api/v1/auth/login",
            new { Email = AppFactory.AdminEmail, Password = AppFactory.AdminPassword });

        response.StatusCode.Should().Be(HttpStatusCode.OK);

        var body = await response.Content.ReadFromJsonAsync<AuthResponse>();
        body.Should().NotBeNull();
        body!.AccessToken.Should().NotBeNullOrWhiteSpace();
        body.RefreshToken.Should().NotBeNullOrWhiteSpace();
        body.ExpiresIn.Should().Be(15 * 60);
        body.User.Email.Should().Be(AppFactory.AdminEmail);
        body.User.IsAdmin.Should().BeTrue();
    }

    [Fact]
    public async Task POST_login_WithWrongPassword_Returns401()
    {
        var response = await _anon.PostAsJsonAsync("/api/v1/auth/login",
            new { Email = AppFactory.AdminEmail, Password = "WrongPassword!" });

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task POST_login_WithUnknownEmail_Returns401()
    {
        var response = await _anon.PostAsJsonAsync("/api/v1/auth/login",
            new { Email = "nobody@unknown.com", Password = "AnyPassword1!" });

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task POST_login_WithInvalidEmailFormat_Returns400()
    {
        var response = await _anon.PostAsJsonAsync("/api/v1/auth/login",
            new { Email = "notanemail", Password = "AnyPassword1!" });

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    // ──────────────────────────────────────────────────────────────────
    // REFRESH
    // ──────────────────────────────────────────────────────────────────

    [Fact]
    public async Task POST_refresh_WithValidRefreshToken_Returns200WithNewTokens()
    {
        // Arrange — login pour obtenir les tokens initiaux
        var loginResp = await _anon.PostAsJsonAsync("/api/v1/auth/login",
            new { Email = AppFactory.AdminEmail, Password = AppFactory.AdminPassword });
        var loginBody = await loginResp.Content.ReadFromJsonAsync<AuthResponse>();

        // Act
        var response = await _anon.PostAsJsonAsync("/api/v1/auth/refresh",
            new { RefreshToken = loginBody!.RefreshToken });

        // Assert
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var newBody = await response.Content.ReadFromJsonAsync<AuthResponse>();
        newBody.Should().NotBeNull();
        newBody!.AccessToken.Should().NotBeNullOrWhiteSpace();
        newBody.RefreshToken.Should().NotBe(loginBody.RefreshToken);
    }

    [Fact]
    public async Task POST_refresh_WithInvalidToken_Returns401()
    {
        var response = await _anon.PostAsJsonAsync("/api/v1/auth/refresh",
            new { RefreshToken = "invalid-refresh-token" });

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    // ──────────────────────────────────────────────────────────────────
    // LOGOUT
    // ──────────────────────────────────────────────────────────────────

    [Fact]
    public async Task POST_logout_WithValidToken_Returns204()
    {
        // Arrange — login
        var loginResp = await _anon.PostAsJsonAsync("/api/v1/auth/login",
            new { Email = AppFactory.AdminEmail, Password = AppFactory.AdminPassword });
        var loginBody = await loginResp.Content.ReadFromJsonAsync<AuthResponse>();

        var authClient = _factory.CreateClient();
        authClient.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", loginBody!.AccessToken);

        // Act
        var response = await authClient.PostAsJsonAsync("/api/v1/auth/logout",
            new { RefreshToken = loginBody.RefreshToken });

        // Assert
        response.StatusCode.Should().Be(HttpStatusCode.NoContent);
    }

    [Fact]
    public async Task POST_logout_WithoutJwt_Returns401()
    {
        var response = await _anon.PostAsJsonAsync("/api/v1/auth/logout",
            new { RefreshToken = "any-token" });

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    // ──────────────────────────────────────────────────────────────────
    // CHANGE PASSWORD
    // ──────────────────────────────────────────────────────────────────

    [Fact]
    public async Task POST_changePassword_WithValidCredentials_Returns204()
    {
        // Arrange — créer un utilisateur via admin
        var email  = $"changepw-{Guid.NewGuid():N}@test.local";
        var (token, _) = await _factory.CreateUserAndGetTokenAsync(
            email, password: "InitialPass1!");

        var authClient = _factory.CreateClient();
        authClient.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", token);

        // Act
        var response = await authClient.PostAsJsonAsync("/api/v1/auth/change-password",
            new { CurrentPassword = "InitialPass1!", NewPassword = "NewPassword1!" });

        // Assert
        response.StatusCode.Should().Be(HttpStatusCode.NoContent);
    }

    [Fact]
    public async Task POST_changePassword_WithWrongCurrentPassword_Returns400()
    {
        var (token, _) = await _factory.CreateUserAndGetTokenAsync(
            $"changepw2-{Guid.NewGuid():N}@test.local", password: "InitialPass1!");

        var authClient = _factory.CreateClient();
        authClient.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", token);

        var response = await authClient.PostAsJsonAsync("/api/v1/auth/change-password",
            new { CurrentPassword = "WrongPassword!", NewPassword = "NewPassword1!" });

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }
}
