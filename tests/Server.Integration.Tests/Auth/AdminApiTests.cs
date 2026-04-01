// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Tests d'intégration — API Admin
// Couvre : list users, create user, reset password, revoke sessions, disable user

using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using FluentAssertions;
using Savoire.Application.Admin.DTOs;
using Savoire.Application.Auth.DTOs;

namespace Savoire.Server.Integration.Tests.Auth;

[Collection("Integration")]
public class AdminApiTests : IClassFixture<AppFactory>
{
    private readonly AppFactory _factory;

    public AdminApiTests(AppFactory factory)
    {
        _factory = factory;
    }

    // ──────────────────────────────────────────────────────────────────
    // ACCÈS NON AUTORISÉ
    // ──────────────────────────────────────────────────────────────────

    [Fact]
    public async Task GET_admin_users_WithoutToken_Returns401()
    {
        var client = _factory.CreateClient();
        var response = await client.GetAsync("/api/v1/admin/users");
        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task GET_admin_users_WithNonAdminToken_Returns403()
    {
        var (token, _) = await _factory.CreateUserAndGetTokenAsync(
            $"nonadmin-{Guid.NewGuid():N}@test.local");

        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", token);

        var response = await client.GetAsync("/api/v1/admin/users");
        response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    // ──────────────────────────────────────────────────────────────────
    // LIST USERS
    // ──────────────────────────────────────────────────────────────────

    [Fact]
    public async Task GET_admin_users_WithAdminToken_Returns200WithUserList()
    {
        var client = await _factory.CreateAdminClientAsync();

        var response = await client.GetAsync("/api/v1/admin/users");

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var users = await response.Content.ReadFromJsonAsync<AdminUserDto[]>();
        users.Should().NotBeNull();
        users.Should().Contain(u => u.Email == AppFactory.AdminEmail && u.IsAdmin);
    }

    // ──────────────────────────────────────────────────────────────────
    // CREATE USER
    // ──────────────────────────────────────────────────────────────────

    [Fact]
    public async Task POST_admin_users_ValidRequest_Returns201()
    {
        var admin = await _factory.CreateAdminClientAsync();

        var response = await admin.PostAsJsonAsync("/api/v1/admin/users", new
        {
            Email = $"newuser-{Guid.NewGuid():N}@test.local",
            Password = "Password123!",
            DisplayName = "Nouvel User"
        });

        response.StatusCode.Should().Be(HttpStatusCode.Created);
        var body = await response.Content.ReadFromJsonAsync<AuthUserDto>();
        body.Should().NotBeNull();
        body!.IsAdmin.Should().BeFalse();
    }

    [Fact]
    public async Task POST_admin_users_DuplicateEmail_Returns400()
    {
        var admin = await _factory.CreateAdminClientAsync();
        var email = $"dup-{Guid.NewGuid():N}@test.local";

        await admin.PostAsJsonAsync("/api/v1/admin/users", new
        {
            Email = email,
            Password = "Password123!",
            DisplayName = "User"
        });

        var response = await admin.PostAsJsonAsync("/api/v1/admin/users", new
        {
            Email = email,
            Password = "Other123456!",
            DisplayName = "User2"
        });

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    // ──────────────────────────────────────────────────────────────────
    // RESET PASSWORD
    // ──────────────────────────────────────────────────────────────────

    [Fact]
    public async Task POST_admin_users_ResetPassword_RevokesExistingSessions()
    {
        var admin = await _factory.CreateAdminClientAsync();
        var email = $"resetme-{Guid.NewGuid():N}@test.local";

        // Créer un user et le connecter
        await admin.PostAsJsonAsync("/api/v1/admin/users", new
        {
            Email = email,
            Password = "OldPassword123!",
            DisplayName = "User"
        });

        var anon = _factory.CreateClient();
        var loginResp = await anon.PostAsJsonAsync("/api/v1/auth/login", new
        {
            Email = email,
            Password = "OldPassword123!"
        });
        var auth = await loginResp.Content.ReadFromJsonAsync<AuthResponse>();

        // Admin reset le mdp — trouver le userId
        var users = await (await _factory.CreateAdminClientAsync())
            .GetFromJsonAsync<AdminUserDto[]>("/api/v1/admin/users");
        var userId = users!.First(u => u.Email == email).Id;

        await admin.PostAsJsonAsync(
            $"/api/v1/admin/users/{userId}/reset-password",
            new { NewPassword = "NewPassword456!" });

        // L'ancien refresh token ne fonctionne plus
        var refreshResp = await anon.PostAsJsonAsync("/api/v1/auth/refresh", new
        {
            RefreshToken = auth!.RefreshToken
        });
        refreshResp.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    // ──────────────────────────────────────────────────────────────────
    // REVOKE SESSIONS
    // ──────────────────────────────────────────────────────────────────

    [Fact]
    public async Task POST_admin_revokeSessions_WithAdminToken_Returns204()
    {
        var (_, userId) = await _factory.CreateUserAndGetTokenAsync(
            $"revoke-{Guid.NewGuid():N}@test.local");

        var client = await _factory.CreateAdminClientAsync();
        var response = await client.PostAsJsonAsync(
            $"/api/v1/admin/users/{userId}/revoke-sessions", new { });

        response.StatusCode.Should().Be(HttpStatusCode.NoContent);
    }

    [Fact]
    public async Task POST_admin_revokeSessions_WithUnknownUser_Returns404()
    {
        var client = await _factory.CreateAdminClientAsync();
        var response = await client.PostAsJsonAsync(
            "/api/v1/admin/users/unknown-user-id/revoke-sessions", new { });

        response.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    // ──────────────────────────────────────────────────────────────────
    // DISABLE USER
    // ──────────────────────────────────────────────────────────────────

    [Fact]
    public async Task POST_admin_disableUser_WithAdminToken_Returns204()
    {
        var (_, userId) = await _factory.CreateUserAndGetTokenAsync(
            $"disable-{Guid.NewGuid():N}@test.local");

        var client = await _factory.CreateAdminClientAsync();
        var response = await client.PostAsJsonAsync(
            $"/api/v1/admin/users/{userId}/disable", new { });

        response.StatusCode.Should().Be(HttpStatusCode.NoContent);
    }

    [Fact]
    public async Task POST_admin_disableUser_DisabledUserCannotLogin()
    {
        var email    = $"disable2-{Guid.NewGuid():N}@test.local";
        var password = "TestPass1!";

        var (_, userId) = await _factory.CreateUserAndGetTokenAsync(email, password);

        // Désactiver
        var adminClient = await _factory.CreateAdminClientAsync();
        await adminClient.PostAsJsonAsync($"/api/v1/admin/users/{userId}/disable", new { });

        // Tenter de se connecter → compte verrouillé (401)
        var loginResp = await _factory.CreateClient().PostAsJsonAsync(
            "/api/v1/auth/login", new { Email = email, Password = password });

        loginResp.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }
}
