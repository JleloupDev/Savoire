// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Tests d'intégration — API Metadata, Backlinks, Tags, IndexSnapshot

using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using FluentAssertions;
using Savoire.Application.Common;

namespace Savoire.Server.Integration.Tests.Metadata;

[Collection("Integration")]
public class MetadataApiTests : IClassFixture<AppFactory>, IAsyncLifetime
{
    private readonly AppFactory _factory;
    private HttpClient _client = null!;
    private string _vaultId = null!;

    public MetadataApiTests(AppFactory factory) => _factory = factory;

    public async Task InitializeAsync()
    {
        var uid = Guid.NewGuid().ToString("N")[..8];
        var (token, userId) = await _factory.CreateUserAndGetTokenAsync($"meta-{uid}@test.com");
        _client = _factory.CreateClient();
        _client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);

        var vaultResp = await _client.PostAsJsonAsync($"/api/v1/users/{userId}/vaults", new { name = "MetaVault" });
        vaultResp.EnsureSuccessStatusCode();
        var vault = await vaultResp.Content.ReadFromJsonAsync<VaultSummaryDto>();
        _vaultId = vault!.Id;
    }

    public Task DisposeAsync() => Task.CompletedTask;

    private async Task<DocumentDto> CreateDocAsync(string path, string content = "# Test")
    {
        var resp = await _client.PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/documents",
            new { path, content });
        resp.EnsureSuccessStatusCode();
        return (await resp.Content.ReadFromJsonAsync<DocumentDto>())!;
    }

    // ── POST index ────────────────────────────────────────────────────────────

    [Fact]
    public async Task POST_index_ReturnsNoContent()
    {
        var doc = await CreateDocAsync("note.md");

        var resp = await _client.PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/documents/{doc.Id}/index",
            new { MarkdownContent = "# Note\n#tag1" });

        resp.StatusCode.Should().Be(HttpStatusCode.NoContent);
    }

    // ── GET meta ─────────────────────────────────────────────────────────────

    [Fact]
    public async Task GET_meta_AfterIndex_ReturnsTags()
    {
        var doc = await CreateDocAsync("tagged.md");

        await _client.PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/documents/{doc.Id}/index",
            new { MarkdownContent = "# Note\n#alpha #beta" });

        var resp = await _client.GetAsync(
            $"/api/v1/vaults/{_vaultId}/documents/{doc.Id}/meta");

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var meta = await resp.Content.ReadFromJsonAsync<DocumentMetaDto>();
        meta.Should().NotBeNull();
        meta!.Tags.Should().Contain("alpha");
        meta.Tags.Should().Contain("beta");
    }

    [Fact]
    public async Task GET_meta_BeforeIndex_ReturnsNoContent()
    {
        var doc = await CreateDocAsync("unindexed.md");

        var resp = await _client.GetAsync(
            $"/api/v1/vaults/{_vaultId}/documents/{doc.Id}/meta");

        // Avant indexation, aucune meta n'existe.
        // ASP.NET Core retourne 204 NoContent quand Ok(null).
        resp.StatusCode.Should().Be(HttpStatusCode.NoContent);
    }

    // ── GET backlinks ─────────────────────────────────────────────────────────

    [Fact]
    public async Task GET_backlinks_WhenDocLinkedByAnother_ReturnsSourceDoc()
    {
        var target = await CreateDocAsync("Destination.md");
        var source = await CreateDocAsync("Source.md");

        // Indexer le document source avec un lien vers la destination
        await _client.PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/documents/{source.Id}/index",
            new { MarkdownContent = $"Voir [[Destination]]." });

        var resp = await _client.GetAsync(
            $"/api/v1/vaults/{_vaultId}/backlinks/{target.Id}");

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var backlinks = await resp.Content.ReadFromJsonAsync<BacklinkDto[]>();
        backlinks.Should().NotBeNull();
        backlinks!.Should().ContainSingle(b => b.DocId == source.Id);
    }

    [Fact]
    public async Task GET_backlinks_WithNoLinks_ReturnsEmptyList()
    {
        var doc = await CreateDocAsync("isolated.md");

        var resp = await _client.GetAsync(
            $"/api/v1/vaults/{_vaultId}/backlinks/{doc.Id}");

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var backlinks = await resp.Content.ReadFromJsonAsync<BacklinkDto[]>();
        backlinks.Should().BeEmpty();
    }

    // ── GET tags ──────────────────────────────────────────────────────────────

    [Fact]
    public async Task GET_tags_AfterIndexingMultipleDocs_ReturnsAllTags()
    {
        var doc1 = await CreateDocAsync("doc1.md");
        var doc2 = await CreateDocAsync("doc2.md");

        await _client.PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/documents/{doc1.Id}/index",
            new { MarkdownContent = "# Doc1\n#tagA #tagB" });
        await _client.PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/documents/{doc2.Id}/index",
            new { MarkdownContent = "# Doc2\n#tagB #tagC" });

        var resp = await _client.GetAsync($"/api/v1/vaults/{_vaultId}/tags");

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var tags = await resp.Content.ReadFromJsonAsync<string[]>();
        tags.Should().Contain("tagA");
        tags.Should().Contain("tagB");
        tags.Should().Contain("tagC");
    }

    [Fact]
    public async Task GET_tags_AreDeduplicated()
    {
        var doc1 = await CreateDocAsync("dedup1.md");
        var doc2 = await CreateDocAsync("dedup2.md");

        await _client.PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/documents/{doc1.Id}/index",
            new { MarkdownContent = "# A\n#shared" });
        await _client.PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/documents/{doc2.Id}/index",
            new { MarkdownContent = "# B\n#shared" });

        var resp = await _client.GetAsync($"/api/v1/vaults/{_vaultId}/tags");
        var tags = await resp.Content.ReadFromJsonAsync<string[]>();
        tags!.Count(t => t.Equals("shared", StringComparison.OrdinalIgnoreCase)).Should().Be(1);
    }

    // ── GET/PUT index-snapshot ────────────────────────────────────────────────

    [Fact]
    public async Task GET_snapshot_WhenNoneExists_Returns404()
    {
        var resp = await _client.GetAsync(
            $"/api/v1/vaults/{_vaultId}/index-snapshots/backlinks");

        resp.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task PUT_snapshot_ThenGet_ReturnsSameData()
    {
        var data = "{\"count\":42}";

        var putResp = await _client.PutAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/index-snapshots/backlinks",
            new SaveIndexSnapshotRequest("backlinks", 100, data));
        putResp.StatusCode.Should().Be(HttpStatusCode.NoContent);

        var getResp = await _client.GetAsync(
            $"/api/v1/vaults/{_vaultId}/index-snapshots/backlinks");
        getResp.StatusCode.Should().Be(HttpStatusCode.OK);

        var snap = await getResp.Content.ReadFromJsonAsync<IndexSnapshotDto>();
        snap.Should().NotBeNull();
        snap!.Data.Should().Be(data);
        snap.ProcessedSeq.Should().Be(100);
        snap.Namespace.Should().Be("backlinks");
    }

    [Fact]
    public async Task PUT_snapshot_SecondPut_OverwritesPrevious()
    {
        await _client.PutAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/index-snapshots/tags",
            new SaveIndexSnapshotRequest("tags", 10, "{\"v\":1}"));
        await _client.PutAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/index-snapshots/tags",
            new SaveIndexSnapshotRequest("tags", 50, "{\"v\":2}"));

        var resp = await _client.GetAsync(
            $"/api/v1/vaults/{_vaultId}/index-snapshots/tags");
        var snap = await resp.Content.ReadFromJsonAsync<IndexSnapshotDto>();
        snap!.ProcessedSeq.Should().Be(50);
        snap.Data.Should().Be("{\"v\":2}");
    }
}
