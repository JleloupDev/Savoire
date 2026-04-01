// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Tests d'intégration — API Synchronisation
// DECISION V2: Utilise JWT Bearer auth au lieu du header X-User-Id.

using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using FluentAssertions;
using Savoire.Server.Models.Dto;

namespace Savoire.Server.Integration.Tests.Sync;

[Collection("Integration")]
public class SyncApiTests : IClassFixture<AppFactory>, IAsyncLifetime
{
    private readonly AppFactory _factory;
    private HttpClient _client = null!;
    private string _userId = null!;

    public SyncApiTests(AppFactory factory) => _factory = factory;

    public async Task InitializeAsync()
    {
        var uid = Guid.NewGuid().ToString("N")[..8];
        var (token, userId) = await _factory.CreateUserAndGetTokenAsync(
            $"sync-{uid}@test.com", displayName: "Sync User");
        _userId = userId;
        _client = _factory.CreateClient();
        _client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
    }

    public Task DisposeAsync() => Task.CompletedTask;

    private async Task<(string vaultId, string docId)> CreateVaultAndDocAsync()
    {
        var vaultResp = await _client.PostAsJsonAsync($"/api/v1/users/{_userId}/vaults", new { name = "Sync Vault" });
        vaultResp.EnsureSuccessStatusCode();
        var vault = (await vaultResp.Content.ReadFromJsonAsync<VaultSummaryDto>())!;

        var docResp = await _client.PostAsJsonAsync(
            $"/api/v1/vaults/{vault.Id}/documents",
            new { path = "sync-test.md", content = "# Sync Test" });
        docResp.EnsureSuccessStatusCode();
        var doc = (await docResp.Content.ReadFromJsonAsync<DocumentDto>())!;

        return (vault.Id, doc.Id);
    }

    [Fact]
    public async Task POST_operations_StoresOps_In_Log()
    {
        // Arrange
        var (vaultId, docId) = await CreateVaultAndDocAsync();
        byte[] fakeOp = [0x01, 0x02, 0x03, 0x04];

        // Act
        var response = await _client.PostAsJsonAsync(
            $"/api/v1/vaults/{vaultId}/documents/{docId}/operations",
            new
            {
                clientId   = "client-test",
                producedAt = DateTime.UtcNow,
                ops        = fakeOp
            });

        // Assert
        response.StatusCode.Should().Be(HttpStatusCode.NoContent);
    }

    [Fact]
    public async Task POST_sync_WithEmptyVector_Returns_AllOps()
    {
        // Arrange — pousser quelques ops
        var (vaultId, docId) = await CreateVaultAndDocAsync();
        byte[] op1 = [0x01, 0x02];
        byte[] op2 = [0x03, 0x04];

        await _client.PostAsJsonAsync(
            $"/api/v1/vaults/{vaultId}/documents/{docId}/operations",
            new { clientId = "client-A", producedAt = DateTime.UtcNow, ops = op1 });
        await _client.PostAsJsonAsync(
            $"/api/v1/vaults/{vaultId}/documents/{docId}/operations",
            new { clientId = "client-A", producedAt = DateTime.UtcNow, ops = op2 });

        // Act
        var response = await _client.PostAsJsonAsync(
            $"/api/v1/vaults/{vaultId}/documents/{docId}/sync",
            new
            {
                clientId    = "client-B",
                stateVector = Array.Empty<byte>(),
                lastSyncAt  = (DateTime?)null
            });

        // Assert
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var syncResp = await response.Content.ReadFromJsonAsync<SyncResponseDto>();
        syncResp!.MissingOps.Should().HaveCount(2);
    }

    [Fact]
    public async Task GET_sync_status_Returns_Changes_Since_Timestamp()
    {
        // Arrange
        var (vaultId, _) = await CreateVaultAndDocAsync();
        var since = DateTime.UtcNow.AddMinutes(-1).ToString("O");

        // Act
        var response = await _client.GetAsync(
            $"/api/v1/vaults/{vaultId}/sync/status?since={since}");

        // Assert
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var status = await response.Content.ReadFromJsonAsync<SyncStatusDto>();
        status.Should().NotBeNull();
        status!.Changes.Should().NotBeNull();
    }
}
