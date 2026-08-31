// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Tests d'intégration — Contrôle d'accès (rôles + permissions ACL)
//
// Rôles vault membership : "owner" | "editor" | "viewer"
//   owner   → lecture + écriture + administration
//   editor  → lecture + écriture
//   viewer  → lecture seulement (créer/modifier/supprimer → 403)
//
// Permissions ACL (sharing) : "read" | "write" | "admin"
//   utilisées pour le partage fin-grained (ResourcePermission)
//
// Scénarios :
//   ACL-10  Non-membre ne peut pas accéder au contenu d'un document → 404
//   ACL-11  Retrait de membre → accès révoqué immédiatement
//   ACL-13  Grant permission ACL + retrait → accès disparu du listing
//
// Note : les mutations document/dossier passent désormais par le CRDT
// (plus de routes REST CRUD) — ces scénarios sont couverts côté frontend.

using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using FluentAssertions;
using Savoire.Application.Common;

namespace Savoire.Server.Integration.Tests.Sharing;

[Collection("Integration")]
public class AccessControlTests : IClassFixture<AppFactory>, IAsyncLifetime
{
    private readonly AppFactory _factory;
    private HttpClient _owner    = null!;
    private HttpClient _viewer   = null!;
    private HttpClient _outsider = null!;
    private string _ownerId   = null!;
    private string _viewerId  = null!;
    private string _vaultId   = null!;

    public AccessControlTests(AppFactory factory) => _factory = factory;

    public async Task InitializeAsync()
    {
        var uid = Guid.NewGuid().ToString("N")[..8];

        var (to, uo) = await _factory.CreateUserAndGetTokenAsync($"acl-owner-{uid}@test.com");
        _ownerId = uo;
        _owner   = _factory.CreateClient();
        _owner.DefaultRequestHeaders.Authorization   = new AuthenticationHeaderValue("Bearer", to);

        var (tv, uv) = await _factory.CreateUserAndGetTokenAsync($"acl-viewer-{uid}@test.com");
        _viewerId = uv;
        _viewer   = _factory.CreateClient();
        _viewer.DefaultRequestHeaders.Authorization  = new AuthenticationHeaderValue("Bearer", tv);

        var (tx, _) = await _factory.CreateUserAndGetTokenAsync($"acl-outside-{uid}@test.com");
        _outsider = _factory.CreateClient();
        _outsider.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", tx);

        // Créer le vault (owner)
        var vresp = await _owner.PostAsJsonAsync(
            $"/api/v1/users/{_ownerId}/vaults", new { name = "ACL Vault" });
        vresp.EnsureSuccessStatusCode();
        var vault = await vresp.Content.ReadFromJsonAsync<VaultSummaryDto>();
        _vaultId = vault!.Id;

        // Ajouter viewer
        await _owner.PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/members", new { userId = _viewerId, role = "viewer" });
    }

    public Task DisposeAsync() => Task.CompletedTask;

    // ── ACL-10 : Non-membre ne peut pas accéder au contenu d'un document ─────

    [Fact]
    public async Task ACL10_Outsider_CannotAccessVaultDocuments_Returns404()
    {
        // 404 intentionnel : on ne révèle pas l'existence du vault à un non-membre.
        // L'endpoint index-snapshot est protégé par RequireReadAsync (membre vault).
        var resp = await _outsider.GetAsync(
            $"/api/v1/vaults/{_vaultId}/index-snapshots/backlinks");
        resp.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    // ── ACL-11 : Retrait de membre → accès révoqué ───────────────────────────

    [Fact]
    public async Task ACL11_RemoveMember_RevokesAccess()
    {
        // Le vault apparait dans l'espace du viewer tant qu'il en est membre.
        // (Le vehicule etait l'API index-snapshots, supprimee avec la bascule
        // des index en CRDT : le listing exprime la meme chose, plus directement.)
        var before = await _viewer.GetFromJsonAsync<WorkspaceProbe>($"/api/v1/users/{_viewerId}/vaults");
        before!.Vaults.Should().Contain(v => v.Id == _vaultId);

        // Owner retire viewer
        await _owner.DeleteAsync($"/api/v1/vaults/{_vaultId}/members/{_viewerId}");

        // viewer ne voit plus le vault
        var after = await _viewer.GetFromJsonAsync<WorkspaceProbe>($"/api/v1/users/{_viewerId}/vaults");
        after!.Vaults.Should().NotContain(v => v.Id == _vaultId);

        // Remettre viewer pour les autres tests
        await _owner.PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/members", new { userId = _viewerId, role = "viewer" });
    }

    // ── ACL-13 : Grant ACL permission → visible dans le listing + retrait ────

    [Fact]
    public async Task ACL13_GrantAndRevokeACLPermission_AppearsAndDisappearsInSharing()
    {
        var (targetToken, targetId) = await _factory.CreateUserAndGetTokenAsync(
            $"acl-target-{Guid.NewGuid():N}@test.com");

        // Grant write
        var grantResp = await _owner.PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/sharing/permissions",
            new { subjectId = targetId, permission = "write", expiresAt = (DateTime?)null });
        grantResp.StatusCode.Should().Be(HttpStatusCode.OK);

        // Vérifie dans le listing
        var sharingResp = await _owner.GetAsync($"/api/v1/vaults/{_vaultId}/sharing");
        var sharing = await sharingResp.Content.ReadFromJsonAsync<ResourceSharingDto>();
        sharing!.Permissions.Should().Contain(p => p.SubjectId == targetId && p.Permission == "write");

        // Retrait
        var revokeResp = await _owner.DeleteAsync(
            $"/api/v1/vaults/{_vaultId}/sharing/permissions/{targetId}");
        revokeResp.StatusCode.Should().Be(HttpStatusCode.NoContent);

        // Plus dans le listing
        var sharingAfter = await (await _owner.GetAsync($"/api/v1/vaults/{_vaultId}/sharing"))
            .Content.ReadFromJsonAsync<ResourceSharingDto>();
        sharingAfter!.Permissions.Should().NotContain(p => p.SubjectId == targetId);
    }

}

/// <summary>Sonde minimale du workspace, pour les assertions d'acces.</summary>
public sealed record WorkspaceProbe(List<WorkspaceProbeVault> Vaults);
public sealed record WorkspaceProbeVault(string Id, string Name);
