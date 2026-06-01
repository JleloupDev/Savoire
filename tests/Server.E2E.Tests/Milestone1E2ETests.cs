// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Tests End-to-End — Milestone 1
// Ces tests correspondent aux 12 critères de done du Milestone 1.
// Chaque test simule un scénario complet : HTTP + SignalR.
// DECISION V2: Utilise JWT Bearer auth au lieu du header X-User-Id.

using System.Diagnostics;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using FluentAssertions;
using Savoire.Server.Integration.Tests;
using Savoire.Server.Models.Dto;
using WorkspaceDto = Savoire.Application.Common.WorkspaceDto;

namespace Savoire.Server.E2E.Tests;

[Collection("E2E")]
public class Milestone1E2ETests : IAsyncLifetime
{
    private AppFactory   _server  = null!;
    private HttpClient   _clientA = null!;
    private HttpClient   _clientB = null!;
    private string       _userIdA = null!;
    private string       _userIdB = null!;
    private string       _tokenA  = null!;
    private string       _tokenB  = null!;

    public async Task InitializeAsync()
    {
        _server = new AppFactory();
        var uid = Guid.NewGuid().ToString("N")[..8];

        (_tokenA, _userIdA) = await _server.CreateUserAndGetTokenAsync(
            $"e2e-a-{uid}@test.com", displayName: "E2E User A");
        _clientA = _server.CreateClient();
        _clientA.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", _tokenA);

        (_tokenB, _userIdB) = await _server.CreateUserAndGetTokenAsync(
            $"e2e-b-{uid}@test.com", displayName: "E2E User B");
        _clientB = _server.CreateClient();
        _clientB.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", _tokenB);
    }

    public async Task DisposeAsync()
    {
        _clientA.Dispose();
        _clientB.Dispose();
        await _server.DisposeAsync();
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    private async Task<VaultSummaryDto> CreateVaultAsync(HttpClient client, string name)
    {
        // Determine userId from which client is passed
        string userId = client == _clientA ? _userIdA : _userIdB;
        var resp = await client.PostAsJsonAsync($"/api/v1/users/{userId}/vaults", new { name });
        resp.EnsureSuccessStatusCode();
        return (await resp.Content.ReadFromJsonAsync<VaultSummaryDto>())!;
    }

    // ── M1-01 ────────────────────────────────────────────────────────────────

    /// <summary>M1-01 : Créer un vault → il apparaît dans la liste.</summary>
    [Fact]
    public async Task CreateVault_AppearsInList()
    {
        var vault = await CreateVaultAsync(_clientA, "Mon Vault E2E");

        var resp      = await _clientA.GetAsync($"/api/v1/users/{_userIdA}/vaults");
        var workspace = await resp.Content.ReadFromJsonAsync<WorkspaceDto>();

        workspace!.Vaults.Should().Contain(v => v.Id == vault.Id);
    }

    // ── M1-11 & M1-12 ────────────────────────────────────────────────────────

    /// <summary>M1-11 : Détection de conflit (placeholder — nécessite ConflictResolver V2).</summary>
    [Fact(Skip = "ConflictResolver non implémenté en V1")]
    public Task ConflictDetected_UIReceivesSyncConflictEvent()
        => Task.CompletedTask;

}
