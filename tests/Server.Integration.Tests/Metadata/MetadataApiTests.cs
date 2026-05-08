// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Tests d'intégration — API Metadata : IndexSnapshot

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
