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

    [Fact]
    public async Task PATCH_folder_Rename_Updates_All_Child_Documents()
    {
        // Arrange — créer dossier + document enfant
        var vault  = await CreateVaultAsync("Vault Renommage");
        var folder = await CreateFolderAsync(vault.Id, "Projets");

        await _client.PostAsJsonAsync(
            $"/api/v1/vaults/{vault.Id}/documents",
            new { path = "Projets/alpha.md", content = "# Alpha" });
        await _client.PostAsJsonAsync(
            $"/api/v1/vaults/{vault.Id}/documents",
            new { path = "Projets/beta.md", content = "# Beta" });

        // Act
        var response = await _client.PatchAsJsonAsync(
            $"/api/v1/vaults/{vault.Id}/folders/{folder.Id}",
            new { path = "Archives" });

        // Assert
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var result = await response.Content.ReadFromJsonAsync<FolderMoveResultDto>();
        result!.MovedDocuments.Should().Be(2);

        // Vérifier que les docs ont le nouveau path
        var docsResp = await _client.GetAsync(
            $"/api/v1/vaults/{vault.Id}/documents?folder=Archives");
        var docs = await docsResp.Content.ReadFromJsonAsync<DocumentDto[]>();
        docs!.Should().HaveCount(2);
        docs.Should().OnlyContain(d => d.Path.StartsWith("Archives/"));
    }

    [Fact]
    public async Task DELETE_folder_NonEmpty_Without_Force_Returns_400()
    {
        // Arrange
        var vault  = await CreateVaultAsync("Vault Suppression");
        var folder = await CreateFolderAsync(vault.Id, "NonVide");

        await _client.PostAsJsonAsync(
            $"/api/v1/vaults/{vault.Id}/documents",
            new { path = "NonVide/note.md", content = "# Note" });

        // Act
        var response = await _client.DeleteAsync(
            $"/api/v1/vaults/{vault.Id}/folders/{folder.Id}");

        // Assert
        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task DELETE_folder_NonEmpty_With_Force_SoftDeletes_All()
    {
        // Arrange
        var vault  = await CreateVaultAsync("Vault Force");
        var folder = await CreateFolderAsync(vault.Id, "ASupprimer");

        await _client.PostAsJsonAsync(
            $"/api/v1/vaults/{vault.Id}/documents",
            new { path = "ASupprimer/note1.md", content = "# Note 1" });
        await _client.PostAsJsonAsync(
            $"/api/v1/vaults/{vault.Id}/documents",
            new { path = "ASupprimer/note2.md", content = "# Note 2" });

        // Act
        var response = await _client.DeleteAsync(
            $"/api/v1/vaults/{vault.Id}/folders/{folder.Id}?force=true");

        // Assert
        response.StatusCode.Should().Be(HttpStatusCode.NoContent);

        // Les documents ne doivent plus apparaître dans la liste
        var docsResp = await _client.GetAsync(
            $"/api/v1/vaults/{vault.Id}/documents?folder=ASupprimer");
        var docs = await docsResp.Content.ReadFromJsonAsync<DocumentDto[]>();
        docs!.Should().BeEmpty("les documents soft-deleted ne doivent pas apparaître");
    }
}
