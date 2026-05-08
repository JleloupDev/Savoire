// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Tests E2E — GET /api/v1/users/{userId}/vaults (WorkspaceDto)
//
// WS-01  Vault créé → apparaît dans vaults avec role "owner"
// WS-02  Ajouté comme editor → vault apparaît avec role "editor"
// WS-03  Ajouté comme viewer → vault apparaît avec role "viewer"
// WS-04  Vault d'un autre user non membre → absent de vaults
// WS-05  Document partagé via permission → apparaît dans sharedWithMe
// WS-06  sharedWithMe contient le displayName du donneur d'accès
// WS-07  Permission expirée → absente de sharedWithMe
// WS-08  Document supprimé (soft-delete) → absent de sharedWithMe
// WS-09  Permission révoquée → absente de sharedWithMe
// WS-10  Sans notes partagées → sharedWithMe est vide

using System.Net.Http.Headers;
using System.Net.Http.Json;
using FluentAssertions;
using Savoire.Server.Integration.Tests;
using Savoire.Server.Models.Dto;
using WorkspaceDto = Savoire.Application.Common.WorkspaceDto;

namespace Savoire.Server.E2E.Tests;

[Collection("E2E")]
public class WorkspaceE2ETests : IAsyncLifetime
{
    private AppFactory _server  = null!;

    // User A — owner / sharer
    private HttpClient _clientA = null!;
    private string     _userIdA = null!;
    private string     _displayA = null!;

    // User B — invité / bénéficiaire des partages
    private HttpClient _clientB = null!;
    private string     _userIdB = null!;

    public async Task InitializeAsync()
    {
        _server = new AppFactory();
        var uid = Guid.NewGuid().ToString("N")[..8];

        _displayA = $"Owner-{uid}";
        (_tokenA, _userIdA) = await _server.CreateUserAndGetTokenAsync(
            $"ws-a-{uid}@test.com", displayName: _displayA);
        _clientA = _server.CreateClient();
        _clientA.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", _tokenA);

        (_tokenB, _userIdB) = await _server.CreateUserAndGetTokenAsync(
            $"ws-b-{uid}@test.com", displayName: $"Member-{uid}");
        _clientB = _server.CreateClient();
        _clientB.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", _tokenB);
    }

    public async Task DisposeAsync()
    {
        _clientA.Dispose();
        _clientB.Dispose();
        await _server.DisposeAsync();
    }

    private string _tokenA = null!;
    private string _tokenB = null!;

    // ── Helpers ───────────────────────────────────────────────────────────────

    private async Task<VaultSummaryDto> CreateVaultAsync(HttpClient client, string userId, string name)
    {
        var resp = await client.PostAsJsonAsync($"/api/v1/users/{userId}/vaults", new { name });
        resp.EnsureSuccessStatusCode();
        return (await resp.Content.ReadFromJsonAsync<VaultSummaryDto>())!;
    }

    private async Task<WorkspaceDto> GetWorkspaceAsync(HttpClient client, string userId)
    {
        var resp = await client.GetAsync($"/api/v1/users/{userId}/vaults");
        resp.EnsureSuccessStatusCode();
        return (await resp.Content.ReadFromJsonAsync<WorkspaceDto>())!;
    }

    // ── WS-01 ─────────────────────────────────────────────────────────────────

    /// <summary>WS-01 : Vault créé → apparaît dans vaults avec role "owner".</summary>
    [Fact]
    public async Task GetWorkspace_OwnedVault_AppearsWithOwnerRole()
    {
        var vault = await CreateVaultAsync(_clientA, _userIdA, "Vault Owner WS-01");

        var ws = await GetWorkspaceAsync(_clientA, _userIdA);

        ws.Vaults.Should().Contain(v => v.Id == vault.Id && v.Role == "owner");
    }

    // ── WS-02 ─────────────────────────────────────────────────────────────────

    /// <summary>WS-02 : Ajouté comme editor → vault apparaît avec role "editor".</summary>
    [Fact]
    public async Task GetWorkspace_EditorMember_VaultAppearsWithEditorRole()
    {
        var vault = await CreateVaultAsync(_clientA, _userIdA, "Vault Editor WS-02");
        await _clientA.PostAsJsonAsync(
            $"/api/v1/vaults/{vault.Id}/members",
            new { userId = _userIdB, role = "editor" });

        var ws = await GetWorkspaceAsync(_clientB, _userIdB);

        ws.Vaults.Should().Contain(v => v.Id == vault.Id && v.Role == "editor");
    }

    // ── WS-03 ─────────────────────────────────────────────────────────────────

    /// <summary>WS-03 : Ajouté comme viewer → vault apparaît avec role "viewer".</summary>
    [Fact]
    public async Task GetWorkspace_ViewerMember_VaultAppearsWithViewerRole()
    {
        var vault = await CreateVaultAsync(_clientA, _userIdA, "Vault Viewer WS-03");
        await _clientA.PostAsJsonAsync(
            $"/api/v1/vaults/{vault.Id}/members",
            new { userId = _userIdB, role = "viewer" });

        var ws = await GetWorkspaceAsync(_clientB, _userIdB);

        ws.Vaults.Should().Contain(v => v.Id == vault.Id && v.Role == "viewer");
    }

    // ── WS-04 ─────────────────────────────────────────────────────────────────

    /// <summary>WS-04 : Vault d'un autre user sans membership → absent de vaults.</summary>
    [Fact]
    public async Task GetWorkspace_NonMemberVault_AbsentFromVaults()
    {
        var vaultA = await CreateVaultAsync(_clientA, _userIdA, "Vault Privé WS-04");

        var ws = await GetWorkspaceAsync(_clientB, _userIdB);

        ws.Vaults.Should().NotContain(v => v.Id == vaultA.Id);
    }

    // ── WS-10 ─────────────────────────────────────────────────────────────────

    /// <summary>WS-10 : Sans notes partagées → sharedWithMe est vide.</summary>
    [Fact]
    public async Task GetWorkspace_NoSharedNotes_SharedWithMeIsEmpty()
    {
        await CreateVaultAsync(_clientA, _userIdA, "Vault No Share WS-10");

        var ws = await GetWorkspaceAsync(_clientB, _userIdB);

        ws.SharedWithMe.Should().BeEmpty();
    }
}
