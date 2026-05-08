// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Tests d'intégration — API Folders
// DECISION V2: Utilise JWT Bearer auth au lieu du header X-User-Id.

using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using FluentAssertions;
using Savoire.Server.Models.Dto;

namespace Savoire.Server.Integration.Tests.Folders;

[Collection("Integration")]
public class FoldersApiTests : IClassFixture<AppFactory>, IAsyncLifetime
{
    private readonly AppFactory _factory;
    private HttpClient _client = null!;
    private string _userId = null!;

    public FoldersApiTests(AppFactory factory) => _factory = factory;

    public async Task InitializeAsync()
    {
        var uid = Guid.NewGuid().ToString("N")[..8];
        var (token, userId) = await _factory.CreateUserAndGetTokenAsync(
            $"folder-{uid}@test.com", displayName: "Folder User");
        _userId = userId;
        _client = _factory.CreateClient();
        _client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
    }

    public Task DisposeAsync() => Task.CompletedTask;

    private async Task<VaultSummaryDto> CreateVaultAsync(string name = "Test Vault")
    {
        var resp = await _client.PostAsJsonAsync($"/api/v1/users/{_userId}/vaults", new { name });
        resp.EnsureSuccessStatusCode();
        return (await resp.Content.ReadFromJsonAsync<VaultSummaryDto>())!;
    }

    private async Task<FolderDto> CreateFolderAsync(string vaultId, string path)
    {
        var resp = await _client.PostAsJsonAsync(
            $"/api/v1/vaults/{vaultId}/folders",
            new { path });
        resp.EnsureSuccessStatusCode();
        return (await resp.Content.ReadFromJsonAsync<FolderDto>())!;
    }

    [Fact]
    public async Task POST_folder_DeepPath_Creates_All_Intermediate_Folders()
    {
        // Arrange
        var vault = await CreateVaultAsync("Vault Arborescence");

        // Act
        var response = await _client.PostAsJsonAsync(
            $"/api/v1/vaults/{vault.Id}/folders",
            new { path = "A/B/C" });

        // Assert
        response.StatusCode.Should().Be(HttpStatusCode.Created);

        // Vérifier que A, A/B et A/B/C ont été créés
        var listResp = await _client.GetAsync($"/api/v1/vaults/{vault.Id}/folders");
        var folders  = await listResp.Content.ReadFromJsonAsync<FolderDto[]>();
        folders!.Select(f => f.Path).Should().Contain(["A", "A/B", "A/B/C"]);
    }

}
