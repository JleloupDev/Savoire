// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Tests d'intégration — API Sharing
// Couvre les permissions ACL et les liens de partage sur vaults et documents.

using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using FluentAssertions;
using Savoire.Application.Common;

namespace Savoire.Server.Integration.Tests.Sharing;

[Collection("Integration")]
public class SharingApiTests : IClassFixture<AppFactory>, IAsyncLifetime
{
    private readonly AppFactory _factory;

    // User 1 — propriétaire du vault
    private HttpClient _owner = null!;
    private string     _ownerId = null!;

    // User 2 — cible des opérations de partage
    private HttpClient _other = null!;
    private string     _otherId = null!;

    // Client anonyme (sans token)
    private HttpClient _anon = null!;

    private string _vaultId = null!;

    public SharingApiTests(AppFactory factory) => _factory = factory;

    public async Task InitializeAsync()
    {
        var uid = Guid.NewGuid().ToString("N")[..8];

        var (t1, u1) = await _factory.CreateUserAndGetTokenAsync($"share-owner-{uid}@test.com");
        _ownerId = u1;
        _owner   = _factory.CreateClient();
        _owner.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", t1);

        var (t2, u2) = await _factory.CreateUserAndGetTokenAsync($"share-other-{uid}@test.com");
        _otherId = u2;
        _other   = _factory.CreateClient();
        _other.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", t2);

        _anon = _factory.CreateClient();

        // Crée un vault appartenant à _owner
        var resp = await _owner.PostAsJsonAsync(
            $"/api/v1/users/{_ownerId}/vaults", new { name = "Shared Vault" });
        resp.EnsureSuccessStatusCode();
        var vault = await resp.Content.ReadFromJsonAsync<VaultSummaryDto>();
        _vaultId = vault!.Id;
    }

    public Task DisposeAsync() => Task.CompletedTask;

    // ── GET sharing ───────────────────────────────────────────────────────────

    [Fact]
    public async Task GET_vault_sharing_Returns_EmptySharingInfo()
    {
        var resp = await _owner.GetAsync($"/api/v1/vaults/{_vaultId}/sharing");

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var dto = await resp.Content.ReadFromJsonAsync<ResourceSharingDto>();
        dto.Should().NotBeNull();
        dto!.ResourceType.Should().Be("vault");
        dto.ResourceId.Should().Be(_vaultId);
        dto.Permissions.Should().BeEmpty();
        dto.Links.Should().BeEmpty();
    }

    [Fact]
    public async Task GET_vault_sharing_WithoutAuth_Returns_401()
    {
        var resp = await _anon.GetAsync($"/api/v1/vaults/{_vaultId}/sharing");
        resp.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    // ── POST permissions ──────────────────────────────────────────────────────

    [Fact]
    public async Task POST_permissions_GrantsReadPermission_Returns_200()
    {
        var resp = await _owner.PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/sharing/permissions",
            new { subjectId = _otherId, permission = "read", expiresAt = (DateTime?)null });

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var dto = await resp.Content.ReadFromJsonAsync<ResourcePermissionDto>();
        dto.Should().NotBeNull();
        dto!.SubjectId.Should().Be(_otherId);
        dto.Permission.Should().Be("read");
        dto.ResourceType.Should().Be("vault");
        dto.ResourceId.Should().Be(_vaultId);
    }

    [Fact]
    public async Task POST_permissions_AsNonOwner_Returns_403()
    {
        var resp = await _other.PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/sharing/permissions",
            new { subjectId = _otherId, permission = "read", expiresAt = (DateTime?)null });

        resp.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task GET_vault_sharing_ShowsGrantedPermission()
    {
        // Grant
        await _owner.PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/sharing/permissions",
            new { subjectId = _otherId, permission = "write", expiresAt = (DateTime?)null });

        // Verify
        var resp = await _owner.GetAsync($"/api/v1/vaults/{_vaultId}/sharing");
        var dto  = await resp.Content.ReadFromJsonAsync<ResourceSharingDto>();

        dto!.Permissions.Should().Contain(p => p.SubjectId == _otherId && p.Permission == "write");
    }

    // ── DELETE permissions ────────────────────────────────────────────────────

    [Fact]
    public async Task DELETE_permission_Removes_It_Returns_204()
    {
        // Grant
        await _owner.PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/sharing/permissions",
            new { subjectId = _otherId, permission = "read", expiresAt = (DateTime?)null });

        // Revoke
        var resp = await _owner.DeleteAsync(
            $"/api/v1/vaults/{_vaultId}/sharing/permissions/{_otherId}");

        resp.StatusCode.Should().Be(HttpStatusCode.NoContent);

        // Verify removed
        var sharingResp = await _owner.GetAsync($"/api/v1/vaults/{_vaultId}/sharing");
        var sharing = await sharingResp.Content.ReadFromJsonAsync<ResourceSharingDto>();
        sharing!.Permissions.Should().NotContain(p => p.SubjectId == _otherId);
    }

    // ── POST sharing links ────────────────────────────────────────────────────

    [Fact]
    public async Task POST_links_CreatesShareLink_Returns_200()
    {
        var resp = await _owner.PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/sharing/links",
            new { permission = "read", expiresAt = (DateTime?)null });

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var dto = await resp.Content.ReadFromJsonAsync<ShareLinkDto>();
        dto.Should().NotBeNull();
        dto!.Token.Should().NotBeNullOrEmpty();
        dto.Permission.Should().Be("read");
        dto.IsValid.Should().BeTrue();
        dto.ResourceType.Should().Be("vault");
        dto.ResourceId.Should().Be(_vaultId);
    }

    [Fact]
    public async Task POST_links_AsNonOwner_Returns_403()
    {
        var resp = await _other.PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/sharing/links",
            new { permission = "read", expiresAt = (DateTime?)null });

        resp.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    // ── DELETE share link ─────────────────────────────────────────────────────

    [Fact]
    public async Task DELETE_link_Revokes_It_Returns_204()
    {
        // Create
        var createResp = await _owner.PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/sharing/links",
            new { permission = "read", expiresAt = (DateTime?)null });
        var link = await createResp.Content.ReadFromJsonAsync<ShareLinkDto>();

        // Revoke
        var resp = await _owner.DeleteAsync($"/api/v1/sharing/links/{link!.Id}");
        resp.StatusCode.Should().Be(HttpStatusCode.NoContent);

        // Verify revoked in listing
        var sharingResp = await _owner.GetAsync($"/api/v1/vaults/{_vaultId}/sharing");
        var sharing = await sharingResp.Content.ReadFromJsonAsync<ResourceSharingDto>();
        sharing!.Links.Should().Contain(l => l.Id == link.Id && !l.IsValid);
    }

    // ── GET share/{token}/access ──────────────────────────────────────────────

    [Fact]
    public async Task GET_share_access_WithValidToken_Returns_JWT()
    {
        // Create link
        var createResp = await _owner.PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/sharing/links",
            new { permission = "read", expiresAt = (DateTime?)null });
        var link = await createResp.Content.ReadFromJsonAsync<ShareLinkDto>();

        // Exchange token (anonymous)
        var resp = await _anon.GetAsync($"/api/v1/share/{link!.Token}/access");

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var access = await resp.Content.ReadFromJsonAsync<ShareLinkAccessDto>();
        access.Should().NotBeNull();
        access!.AccessToken.Should().NotBeNullOrEmpty();
        access.ResourceType.Should().Be("vault");
        access.ResourceId.Should().Be(_vaultId);
        access.Permission.Should().Be("read");
    }

    [Fact]
    public async Task GET_share_access_WithInvalidToken_Returns_403()
    {
        var resp = await _anon.GetAsync("/api/v1/share/invalid-token-xyz/access");
        resp.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task GET_share_access_WithRevokedLink_Returns_403()
    {
        // Create + revoke
        var createResp = await _owner.PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/sharing/links",
            new { permission = "read", expiresAt = (DateTime?)null });
        var link = await createResp.Content.ReadFromJsonAsync<ShareLinkDto>();

        await _owner.DeleteAsync($"/api/v1/sharing/links/{link!.Id}");

        // Try to exchange revoked token
        var resp = await _anon.GetAsync($"/api/v1/share/{link.Token}/access");
        resp.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

}
