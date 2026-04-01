// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Tests d'intégration — API Vaults
// Teste les endpoints HTTP réels via WebApplicationFactory.
// DECISION V2: Utilise JWT Bearer auth au lieu du header X-User-Id.

using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using FluentAssertions;
using Savoire.Server.Models.Dto;

namespace Savoire.Server.Integration.Tests.Vaults;

[Collection("Integration")]
public class VaultsApiTests : IClassFixture<AppFactory>, IAsyncLifetime
{
    private readonly AppFactory _factory;
    private HttpClient _client = null!;
    private HttpClient _client2 = null!;
    private string _userId = null!;
    private string _otherUserId = null!;

    public VaultsApiTests(AppFactory factory) => _factory = factory;

    public async Task InitializeAsync()
    {
        var uid = Guid.NewGuid().ToString("N")[..8];
        var (token1, userId1) = await _factory.CreateUserAndGetTokenAsync(
            $"vault-u1-{uid}@test.com", displayName: "Vault User 1");
        _userId = userId1;
        _client = _factory.CreateClient();
        _client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token1);

        var (token2, userId2) = await _factory.CreateUserAndGetTokenAsync(
            $"vault-u2-{uid}@test.com", displayName: "Vault User 2");
        _otherUserId = userId2;
        _client2 = _factory.CreateClient();
        _client2.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token2);
    }

    public Task DisposeAsync() => Task.CompletedTask;

    [Fact]
    public async Task POST_vaults_Creates_Vault_And_Returns_201()
    {
        // Act
        var response = await _client.PostAsJsonAsync(
            $"/api/v1/users/{_userId}/vaults",
            new { name ="Mon Vault de Test" });

        // Assert
        response.StatusCode.Should().Be(HttpStatusCode.Created);
        var vault = await response.Content.ReadFromJsonAsync<VaultSummaryDto>();
        vault.Should().NotBeNull();
        vault!.Name.Should().Be("Mon Vault de Test");
        vault.Role.Should().Be("owner");
    }

    [Fact]
    public async Task GET_vaults_Returns_Only_Accessible_Vaults()
    {
        // Arrange — créer un vault
        var postResponse1 = await _client.PostAsJsonAsync($"/api/v1/users/{_userId}/vaults", new { name = "Vault Accessible" });

        // Create vault owned by another user
        var postResponse2 = await _client2.PostAsJsonAsync($"/api/v1/users/{_otherUserId}/vaults", new { name = "Vault Inaccessible" });

        // Act
        var response = await _client.GetAsync($"/api/v1/users/{_userId}/vaults");

        // Assert
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var vaults = await response.Content.ReadFromJsonAsync<VaultSummaryDto[]>();
        vaults.Should().NotBeNull();
        vaults!.Should()
            .Contain(v => v.Name == "Vault Accessible").And
            .NotContain(v => v.Name == "Vault Inaccessible");
    }

    [Fact]
    public async Task POST_vaults_WithoutAuth_Returns_401()
    {
        // Arrange — client sans token
        var anonClient = _factory.CreateClient();

        // Act
        var response = await anonClient.PostAsJsonAsync(
            $"/api/v1/users/{_userId}/vaults",
            new { name ="Vault Anonyme" });

        // Assert
        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task DELETE_vault_ByNonOwner_Returns_403()
    {
        // Arrange — créer un vault en tant que user1
        var createResponse = await _client.PostAsJsonAsync(
            $"/api/v1/users/{_userId}/vaults",
            new { name ="Vault Privé" });
        var vault = await createResponse.Content.ReadFromJsonAsync<VaultSummaryDto>();

        // Act — tenter de supprimer avec user2
        var response = await _client2.DeleteAsync($"/api/v1/vaults/{vault!.Id}");

        // Assert
        response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task POST_clone_Returns_Manifest_With_All_Documents()
    {
        // Arrange — créer vault + document
        var createVaultResp = await _client.PostAsJsonAsync(
            $"/api/v1/users/{_userId}/vaults", new { name = "Vault Clone" });
        var vault = await createVaultResp.Content.ReadFromJsonAsync<VaultSummaryDto>();

        await _client.PostAsJsonAsync(
            $"/api/v1/vaults/{vault!.Id}/documents",
            new { path = "note.md", content = "# Hello" });

        // Act
        var response = await _client.PostAsJsonAsync(
            $"/api/v1/vaults/{vault.Id}/clone",
            new { localPath = "/tmp/vault" });

        // Assert
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var manifest = await response.Content.ReadFromJsonAsync<CloneManifestDto>();
        manifest.Should().NotBeNull();
        manifest!.Documents.Should().Contain(d => d.Path == "note.md");
    }

    [Fact]
    public async Task POST_members_Adds_Member_To_Vault()
    {
        // Arrange
        var createResp = await _client.PostAsJsonAsync(
            $"/api/v1/users/{_userId}/vaults", new { name = "Vault Partagé" });
        var vault = await createResp.Content.ReadFromJsonAsync<VaultSummaryDto>();

        // Act
        var response = await _client.PostAsJsonAsync(
            $"/api/v1/vaults/{vault!.Id}/members",
            new { userId = _otherUserId, role = "editor" });

        // Assert — controller retourne 200 Ok avec un message de confirmation
        response.IsSuccessStatusCode.Should().BeTrue();
    }

    [Fact]
    public async Task POST_members_WithDuplicateUser_Returns_409()
    {
        // Arrange — créer vault et ajouter other-user
        var createResp = await _client.PostAsJsonAsync(
            $"/api/v1/users/{_userId}/vaults", new { name = "Vault Dupliqué" });
        var vault = await createResp.Content.ReadFromJsonAsync<VaultSummaryDto>();

        await _client.PostAsJsonAsync(
            $"/api/v1/vaults/{vault!.Id}/members",
            new { userId = _otherUserId, role = "editor" });

        // Act — ajouter à nouveau
        var response = await _client.PostAsJsonAsync(
            $"/api/v1/vaults/{vault.Id}/members",
            new { userId = _otherUserId, role = "editor" });

        // Assert
        response.StatusCode.Should().Be(HttpStatusCode.Conflict);
    }
}
