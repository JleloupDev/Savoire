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
    private HttpClient _owner    = null!;
    // _target is used by SHARE tests and may be added/removed as vault member across tests.
    private HttpClient _target   = null!;
    // _outsider is a separate user never added to vault_members — used by DOCACL tests.
    private HttpClient _outsider = null!;
    private string _ownerId    = null!;
    private string _targetId   = null!;
    private string _outsiderId = null!;
    private string _vaultId    = null!;

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

        var (tx, ux) = await _factory.CreateUserAndGetTokenAsync($"vs-outside-{uid}@test.com",  displayName: "Outsider");
        _outsiderId = ux;
        _outsider   = _factory.CreateClient();
        _outsider.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", tx);

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

    private async Task<DocumentDto> OwnerCreateDocAsync(string path, string content = "# Test")
    {
        var r = await _owner.PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/documents", new { path, content });
        r.EnsureSuccessStatusCode();
        return (await r.Content.ReadFromJsonAsync<DocumentDto>())!;
    }

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

    // ── SHARE-04 : Viewer (via sharing) → 403 on writes ──────────────────────

    [Fact]
    public async Task SHARE04_VaultReadGrant_TargetIsViewer_WriteDocumentReturns403()
    {
        await GrantVaultAsync("read");

        var resp = await _target.PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/documents",
            new { path = "viewer-write.md", content = "# Forbidden" });

        resp.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    // ── SHARE-05 : Editor (via sharing) → can create ─────────────────────────

    [Fact]
    public async Task SHARE05_VaultWriteGrant_TargetIsEditor_CanCreateDocument()
    {
        await GrantVaultAsync("write");

        var resp = await _target.PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/documents",
            new { path = "editor-write.md", content = "# Allowed" });

        resp.StatusCode.Should().Be(HttpStatusCode.Created);
    }

    // ── DOCACL-01 : Non-member, doc read → can read content ──────────────────

    [Fact]
    public async Task DOCACL01_DocReadPermission_NonMember_CanReadContent()
    {
        var doc = await OwnerCreateDocAsync("shared-read.md", "# Readable");

        (await _owner.PostAsJsonAsync(
            $"/api/v1/documents/{doc.Id}/sharing/permissions",
            new { subjectId = _outsiderId, permission = "read", expiresAt = (DateTime?)null }))
            .EnsureSuccessStatusCode();

        var resp = await _outsider.GetAsync(
            $"/api/v1/vaults/{_vaultId}/documents/{doc.Id}/content");

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    // ── DOCACL-02 : Non-member, doc read → cannot push ops ───────────────────

    [Fact]
    public async Task DOCACL02_DocReadPermission_NonMember_CannotPushOps()
    {
        var doc = await OwnerCreateDocAsync("shared-readonly.md", "# ReadOnly");

        (await _owner.PostAsJsonAsync(
            $"/api/v1/documents/{doc.Id}/sharing/permissions",
            new { subjectId = _outsiderId, permission = "read", expiresAt = (DateTime?)null }))
            .EnsureSuccessStatusCode();

        var resp = await _outsider.PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/documents/{doc.Id}/operations",
            new { clientId = "test-client", producedAt = DateTime.UtcNow, ops = new byte[] { 0x01 } });

        resp.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    // ── DOCACL-03 : Non-member, doc write → can push ops ─────────────────────

    [Fact]
    public async Task DOCACL03_DocWritePermission_NonMember_CanPushOps()
    {
        var doc = await OwnerCreateDocAsync("shared-write.md", "# Writable");

        (await _owner.PostAsJsonAsync(
            $"/api/v1/documents/{doc.Id}/sharing/permissions",
            new { subjectId = _outsiderId, permission = "write", expiresAt = (DateTime?)null }))
            .EnsureSuccessStatusCode();

        var resp = await _outsider.PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/documents/{doc.Id}/operations",
            new { clientId = "test-client", producedAt = DateTime.UtcNow, ops = new byte[] { 0x01 } });

        resp.StatusCode.Should().Be(HttpStatusCode.NoContent);
    }

    // ── DOCACL-04 : Non-member with no permission → 404 ──────────────────────

    [Fact]
    public async Task DOCACL04_NoPermission_NonMember_ContentReturns404()
    {
        var doc = await OwnerCreateDocAsync("invisible.md", "# Invisible");

        var resp = await _outsider.GetAsync(
            $"/api/v1/vaults/{_vaultId}/documents/{doc.Id}/content");

        resp.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }
}
