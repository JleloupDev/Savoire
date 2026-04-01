// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Tests d'intégration — API Documents
// DECISION V2: Utilise JWT Bearer auth au lieu du header X-User-Id.

using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using FluentAssertions;
using Savoire.Server.Models.Dto;

namespace Savoire.Server.Integration.Tests.Documents;

[Collection("Integration")]
public class DocumentsApiTests : IClassFixture<AppFactory>, IAsyncLifetime
{
    private readonly AppFactory _factory;
    private HttpClient _client = null!;
    private string _userId = null!;

    public DocumentsApiTests(AppFactory factory) => _factory = factory;

    public async Task InitializeAsync()
    {
        var uid = Guid.NewGuid().ToString("N")[..8];
        var (token, userId) = await _factory.CreateUserAndGetTokenAsync(
            $"doc-{uid}@test.com", displayName: "Doc User");
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

    private async Task<DocumentDto> CreateDocumentAsync(string vaultId, string path, string content = "# Test")
    {
        var resp = await _client.PostAsJsonAsync(
            $"/api/v1/vaults/{vaultId}/documents",
            new { path, content });
        resp.EnsureSuccessStatusCode();
        return (await resp.Content.ReadFromJsonAsync<DocumentDto>())!;
    }

    private string ResolveDocumentFilePath(string vaultId, string docId)
    {
        string expectedPath = Path.Combine(_factory.TempStoragePath, vaultId, $"{docId}.md");
        if (File.Exists(expectedPath))
            return expectedPath;

        string tempRoot = Path.Combine(Path.GetTempPath(), "poc-tests");
        if (!Directory.Exists(tempRoot))
            return expectedPath;

        return Directory
            .EnumerateFiles(tempRoot, $"{docId}.md", SearchOption.AllDirectories)
            .FirstOrDefault(path => path.Contains(vaultId, StringComparison.OrdinalIgnoreCase))
            ?? expectedPath;
    }

    [Fact]
    public async Task POST_document_Creates_File_On_Disk_And_In_DB()
    {
        // Arrange
        var vault = await CreateVaultAsync("Vault Fichiers");

        // Act
        var response = await _client.PostAsJsonAsync(
            $"/api/v1/vaults/{vault.Id}/documents",
            new { path = "notes/idea.md", content = "# Mon Idée\nContenu." });

        // Assert — DB
        response.StatusCode.Should().Be(HttpStatusCode.Created);
        var doc = await response.Content.ReadFromJsonAsync<DocumentDto>();
        doc.Should().NotBeNull();
        doc!.Path.Should().Be("notes/idea.md");
        doc.Title.Should().Be("Mon Idée");

        // Assert — fichier sur disque
        string filePath = ResolveDocumentFilePath(vault.Id, doc.Id);
        File.Exists(filePath).Should().BeTrue("le fichier .md doit exister sur disque");
    }

    [ Fact]
    public async Task GET_document_content_Returns_Correct_Markdown()
    {
        // Arrange
        var vault = await CreateVaultAsync();
        var doc   = await CreateDocumentAsync(vault.Id, "readme.md", "# Hello World");

        // Act
        var response = await _client.GetAsync(
            $"/api/v1/vaults/{vault.Id}/documents/{doc.Id}/content");

        // Assert
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        string content = await response.Content.ReadAsStringAsync();
        content.Should().Contain("Hello World");
    }

    [Fact]
    public async Task PATCH_document_Rename_Updates_Path()
    {
        // Arrange
        var vault = await CreateVaultAsync();
        var doc   = await CreateDocumentAsync(vault.Id, "original.md");

        // Act
        var response = await _client.PatchAsJsonAsync(
            $"/api/v1/vaults/{vault.Id}/documents/{doc.Id}",
            new { path = "renamed.md" });

        // Assert
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var updated = await response.Content.ReadFromJsonAsync<DocumentDto>();
        updated!.Path.Should().Be("renamed.md");
    }

    [Fact]
    public async Task PATCH_document_ToExistingPath_Returns_409()
    {
        // Arrange
        var vault = await CreateVaultAsync();
        await CreateDocumentAsync(vault.Id, "existing.md");
        var doc = await CreateDocumentAsync(vault.Id, "other.md");

        // Act
        var response = await _client.PatchAsJsonAsync(
            $"/api/v1/vaults/{vault.Id}/documents/{doc.Id}",
            new { path = "existing.md" });

        // Assert
        response.StatusCode.Should().Be(HttpStatusCode.Conflict);
    }

    [Fact]
    public async Task DELETE_document_SoftDeletes_File_Stays_On_Disk()
    {
        // Arrange
        var vault = await CreateVaultAsync();
        var doc   = await CreateDocumentAsync(vault.Id, "to-delete.md", "# À supprimer");
        string filePath = ResolveDocumentFilePath(vault.Id, doc.Id);

        // Act
        var response = await _client.DeleteAsync(
            $"/api/v1/vaults/{vault.Id}/documents/{doc.Id}");

        // Assert — soft delete : 204 et le fichier reste
        response.StatusCode.Should().Be(HttpStatusCode.NoContent);
        filePath = ResolveDocumentFilePath(vault.Id, doc.Id);
        File.Exists(filePath).Should().BeTrue("le fichier physique doit rester après suppression logique");
    }

    [Fact]
    public async Task GET_documents_FiltersByFolder_Correctly()
    {
        // Arrange
        var vault = await CreateVaultAsync();
        await CreateDocumentAsync(vault.Id, "Projets/alpha.md");
        await CreateDocumentAsync(vault.Id, "Projets/beta.md");
        await CreateDocumentAsync(vault.Id, "Inbox/note.md");

        // Act
        var response = await _client.GetAsync(
            $"/api/v1/vaults/{vault.Id}/documents?folder=Projets");

        // Assert
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var docs = await response.Content.ReadFromJsonAsync<DocumentDto[]>();
        docs!.Should().HaveCount(2);
        docs.Should().OnlyContain(d => d.Path.StartsWith("Projets/"));
    }

    [Fact]
    public async Task POST_document_InNonExistentFolder_CreatesFolder()
    {
        // Arrange
        var vault = await CreateVaultAsync();

        // Act
        var response = await _client.PostAsJsonAsync(
            $"/api/v1/vaults/{vault.Id}/documents",
            new { path = "NewFolder/SubFolder/note.md", content = "# Note" });

        // Assert
        response.StatusCode.Should().Be(HttpStatusCode.Created);

        // Vérifier que les dossiers ont été créés
        var foldersResp = await _client.GetAsync(
            $"/api/v1/vaults/{vault.Id}/folders");
        var folders = await foldersResp.Content.ReadFromJsonAsync<FolderDto[]>();
        folders!.Should().Contain(f => f.Path == "NewFolder/SubFolder");
    }
}
