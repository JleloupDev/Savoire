// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Tests d'intégration — API Admin
// Couvre : liste des comptes, blocage d'un compte.
// Les comptes se creent chez le fournisseur d'identite (ADR-028).

using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using FluentAssertions;
using Savoire.Application.Admin.DTOs;

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
    public async Task POST_admin_disableUser_TokensAreRefused_EvenIfValidAtTheIdp()
    {
        var (token, userId) = await _factory.CreateUserAndGetTokenAsync(
            $"disable2-{Guid.NewGuid():N}@test.local");
        var user = _factory.CreateClient();
        user.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        (await user.GetAsync("/api/v1/auth/me")).StatusCode.Should().Be(HttpStatusCode.OK);

        var adminClient = await _factory.CreateAdminClientAsync();
        (await adminClient.PostAsJsonAsync($"/api/v1/admin/users/{userId}/disable", new { }))
            .StatusCode.Should().Be(HttpStatusCode.NoContent);

        // Le meme jeton, toujours valide chez l'IdP : refuse aussitot.
        (await user.GetAsync("/api/v1/auth/me")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }
}
