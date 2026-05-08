// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Integration tests — Vault sharing and access rights on CRDT operations
//
// Vault sharing scenarios (GrantPermission → vault_members):
//   SHARE-01  Grant vault read  → vault appears in recipient's list (viewer role)
//   SHARE-02  Grant vault write → vault appears with editor role
//   SHARE-03  Revoke vault permission → vault disappears from list
//   SHARE-04  Viewer (via sharing) → 403 on write operations (documents)
//   SHARE-05  Editor (via sharing) → can create documents (201)
//
// Document ACL scenarios for non-vault-members:
//   DOCACL-01  Non-member with doc read permission → can read content (200)
//   DOCACL-02  Non-member with doc read permission → cannot push ops (403)
//   DOCACL-03  Non-member with doc write permission → can push ops (204)
//   DOCACL-04  Non-member with no permission → 404 on content (vault hidden)

using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using FluentAssertions;
using Savoire.Application.Common;

namespace Savoire.Server.Integration.Tests.Sharing;

[Collection("Integration")]
public class VaultSharingAccessTests : IClassFixture<AppFactory>, IAsyncLifetime
{
    private readonly AppFactory _factory;
    private HttpClient _owner   = null!;
    // _target is used by SHARE tests and may be added/removed as vault member across tests.
    private HttpClient _target  = null!;
    private string _ownerId   = null!;
    private string _targetId  = null!;
    private string _vaultId   = null!;

    public VaultSharingAccessTests(AppFactory factory) => _factory = factory;

    public async Task InitializeAsync()
    {
        var uid = Guid.NewGuid().ToString("N")[..8];

        var (to, uo) = await _factory.CreateUserAndGetTokenAsync($"vs-owner-{uid}@test.com",    displayName: "Owner");
        _ownerId = uo;
        _owner   = _factory.CreateClient();
        _owner.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", to);

        var (tt, ut) = await _factory.CreateUserAndGetTokenAsync($"vs-target-{uid}@test.com",   displayName: "Target");
        _targetId = ut;
        _target   = _factory.CreateClient();
        _target.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", tt);

        var vresp = await _owner.PostAsJsonAsync(
            $"/api/v1/users/{_ownerId}/vaults", new { name = "Sharing Vault" });
        vresp.EnsureSuccessStatusCode();
        _vaultId = (await vresp.Content.ReadFromJsonAsync<VaultSummaryDto>())!.Id;
    }

    public Task DisposeAsync() => Task.CompletedTask;

    // ── Helpers ───────────────────────────────────────────────────────────────

    private async Task GrantVaultAsync(string permission) =>
        (await _owner.PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/sharing/permissions",
            new { subjectId = _targetId, permission, expiresAt = (DateTime?)null }))
        .EnsureSuccessStatusCode();

    private async Task RevokeVaultAsync() =>
        (await _owner.DeleteAsync(
            $"/api/v1/vaults/{_vaultId}/sharing/permissions/{_targetId}"))
        .EnsureSuccessStatusCode();

    private async Task<WorkspaceDto> TargetGetWorkspaceAsync() =>
        (await (await _target.GetAsync($"/api/v1/users/{_targetId}/vaults"))
            .Content.ReadFromJsonAsync<WorkspaceDto>())!;

    // ── SHARE-01 : Grant vault read → vault visible, viewer role ──────────────

    [Fact]
    public async Task SHARE01_GrantVaultRead_VaultAppearsInTargetListAsViewer()
    {
        await GrantVaultAsync("read");

        var ws = await TargetGetWorkspaceAsync();

        ws.Vaults.Should().Contain(v => v.Id == _vaultId && v.Role == "viewer");
    }

    // ── SHARE-02 : Grant vault write → vault visible, editor role ────────────

    [Fact]
    public async Task SHARE02_GrantVaultWrite_VaultAppearsInTargetListAsEditor()
    {
        await GrantVaultAsync("write");

        var ws = await TargetGetWorkspaceAsync();

        ws.Vaults.Should().Contain(v => v.Id == _vaultId && v.Role == "editor");
    }

    // ── SHARE-03 : Revoke → vault disappears ─────────────────────────────────

    [Fact]
    public async Task SHARE03_RevokeVaultPermission_VaultDisappearsFromTargetList()
    {
        await GrantVaultAsync("read");
        (await TargetGetWorkspaceAsync()).Vaults.Should().Contain(v => v.Id == _vaultId);

        await RevokeVaultAsync();

        (await TargetGetWorkspaceAsync()).Vaults.Should().NotContain(v => v.Id == _vaultId);
    }

}
