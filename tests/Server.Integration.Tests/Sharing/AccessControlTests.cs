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
//   ACL-01  Viewer peut lister les documents
//   ACL-02  Viewer ne peut pas créer un document → 403
//   ACL-03  Viewer ne peut pas modifier le contenu d'un document → 403
//   ACL-04  Viewer ne peut pas renommer un document → 403
//   ACL-05  Viewer ne peut pas supprimer un document → 403
//   ACL-06  Viewer ne peut pas créer un dossier → 403
//   ACL-07  Viewer ne peut pas renommer un dossier → 403
//   ACL-08  Viewer ne peut pas supprimer un dossier → 403
//   ACL-09  Editor peut créer, modifier, renommer, supprimer
//   ACL-10  Non-membre ne peut pas accéder au vault → 404
//   ACL-11  Retrait de membre → accès révoqué immédiatement
//   ACL-12  Promotion viewer → editor débloque l'écriture
//   ACL-13  Grant permission ACL + retrait → accès disparu du listing

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
    private HttpClient _owner   = null!;
    private HttpClient _editor  = null!;
    private HttpClient _viewer  = null!;
    private HttpClient _outsider = null!;
    private string _ownerId   = null!;
    private string _editorId  = null!;
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

        var (te, ue) = await _factory.CreateUserAndGetTokenAsync($"acl-editor-{uid}@test.com");
        _editorId = ue;
        _editor   = _factory.CreateClient();
        _editor.DefaultRequestHeaders.Authorization  = new AuthenticationHeaderValue("Bearer", te);

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

        // Ajouter editor et viewer
        await _owner.PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/members", new { userId = _editorId, role = "editor" });
        await _owner.PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/members", new { userId = _viewerId, role = "viewer" });
    }

    public Task DisposeAsync() => Task.CompletedTask;

    // ── Helpers ───────────────────────────────────────────────────────────────

    private async Task<DocumentDto> OwnerCreateDocAsync(string path, string content = "# Test")
    {
        var resp = await _owner.PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/documents", new { path, content });
        resp.EnsureSuccessStatusCode();
        return (await resp.Content.ReadFromJsonAsync<DocumentDto>())!;
    }

    private async Task<FolderDto> OwnerCreateFolderAsync(string path)
    {
        var resp = await _owner.PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/folders", new { path });
        resp.EnsureSuccessStatusCode();
        return (await resp.Content.ReadFromJsonAsync<FolderDto>())!;
    }

    // ── ACL-01 : Viewer peut lister les documents ─────────────────────────────

    [Fact]
    public async Task ACL01_Viewer_CanListDocuments()
    {
        await OwnerCreateDocAsync("visible.md");
        var resp = await _viewer.GetAsync($"/api/v1/vaults/{_vaultId}/documents");
        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var docs = await resp.Content.ReadFromJsonAsync<DocumentDto[]>();
        docs!.Should().NotBeNull();
    }

    // ── ACL-02 : Viewer ne peut pas créer un document ─────────────────────────

    [Fact]
    public async Task ACL02_Viewer_CannotCreateDocument_Returns403()
    {
        var resp = await _viewer.PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/documents",
            new { path = "viewer-create.md", content = "# Interdit" });
        resp.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    // ── ACL-03 : Viewer ne peut pas modifier le contenu ───────────────────────

    [Fact]
    public async Task ACL03_Viewer_CannotPutContent_Returns403()
    {
        var doc = await OwnerCreateDocAsync("readonly.md", "# Original");
        var resp = await _viewer.PutAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/documents/{doc.Id}/content",
            new { content = "# Modifié par viewer" });
        resp.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    // ── ACL-04 : Viewer ne peut pas renommer un document ─────────────────────

    [Fact]
    public async Task ACL04_Viewer_CannotRenameDocument_Returns403()
    {
        var doc = await OwnerCreateDocAsync("rename-me.md");
        var resp = await _viewer.PatchAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/documents/{doc.Id}",
            new { path = "renamed-by-viewer.md" });
        resp.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    // ── ACL-05 : Viewer ne peut pas supprimer un document ────────────────────

    [Fact]
    public async Task ACL05_Viewer_CannotDeleteDocument_Returns403()
    {
        var doc = await OwnerCreateDocAsync("delete-me.md");
        var resp = await _viewer.DeleteAsync(
            $"/api/v1/vaults/{_vaultId}/documents/{doc.Id}");
        resp.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    // ── ACL-06 : Viewer ne peut pas créer un dossier ─────────────────────────

    [Fact]
    public async Task ACL06_Viewer_CannotCreateFolder_Returns403()
    {
        var resp = await _viewer.PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/folders",
            new { path = "ViewerFolder" });
        resp.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    // ── ACL-07 : Viewer ne peut pas renommer un dossier ──────────────────────

    [Fact]
    public async Task ACL07_Viewer_CannotRenameFolder_Returns403()
    {
        var folder = await OwnerCreateFolderAsync("RenameFolder");
        var resp = await _viewer.PatchAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/folders/{folder.Id}",
            new { path = "RenamedByViewer" });
        resp.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    // ── ACL-08 : Viewer ne peut pas supprimer un dossier ─────────────────────

    [Fact]
    public async Task ACL08_Viewer_CannotDeleteFolder_Returns403()
    {
        var folder = await OwnerCreateFolderAsync("DeleteFolder");
        var resp = await _viewer.DeleteAsync(
            $"/api/v1/vaults/{_vaultId}/folders/{folder.Id}");
        resp.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    // ── ACL-09 : Editor peut tout faire ──────────────────────────────────────

    [Fact]
    public async Task ACL09_Editor_CanCreateRenameDeleteDocument()
    {
        // Create
        var createResp = await _editor.PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/documents",
            new { path = "editor-doc.md", content = "# Editor" });
        createResp.StatusCode.Should().Be(HttpStatusCode.Created);
        var doc = await createResp.Content.ReadFromJsonAsync<DocumentDto>();

        // Rename
        var renameResp = await _editor.PatchAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/documents/{doc!.Id}",
            new { path = "editor-renamed.md" });
        renameResp.StatusCode.Should().Be(HttpStatusCode.OK);

        // Delete
        var deleteResp = await _editor.DeleteAsync(
            $"/api/v1/vaults/{_vaultId}/documents/{doc.Id}");
        deleteResp.StatusCode.Should().Be(HttpStatusCode.NoContent);
    }

    [Fact]
    public async Task ACL09b_Editor_CanCreateRenameDeleteFolder()
    {
        var createResp = await _editor.PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/folders", new { path = "EditorFolder" });
        createResp.StatusCode.Should().Be(HttpStatusCode.Created);
        var folder = await createResp.Content.ReadFromJsonAsync<FolderDto>();

        var renameResp = await _editor.PatchAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/folders/{folder!.Id}",
            new { path = "EditorFolderRenamed" });
        renameResp.StatusCode.Should().Be(HttpStatusCode.OK);

        var deleteResp = await _editor.DeleteAsync(
            $"/api/v1/vaults/{_vaultId}/folders/{folder.Id}");
        deleteResp.StatusCode.Should().Be(HttpStatusCode.NoContent);
    }

    // ── ACL-10 : Non-membre ne peut pas accéder au vault ─────────────────────

    [Fact]
    public async Task ACL10_Outsider_CannotAccessVaultDocuments_Returns404()
    {
        // 404 intentionnel : on ne révèle pas l'existence du vault à un non-membre
        var resp = await _outsider.GetAsync($"/api/v1/vaults/{_vaultId}/documents");
        resp.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task ACL10b_Outsider_CannotCreateDocument_Returns404()
    {
        var resp = await _outsider.PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/documents",
            new { path = "outsider.md", content = "hack" });
        resp.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    // ── ACL-11 : Retrait de membre → accès révoqué ───────────────────────────

    [Fact]
    public async Task ACL11_RemoveMember_RevokesAccess()
    {
        // viewer peut lire avant le retrait
        var before = await _viewer.GetAsync($"/api/v1/vaults/{_vaultId}/documents");
        before.StatusCode.Should().Be(HttpStatusCode.OK);

        // Owner retire viewer
        await _owner.DeleteAsync($"/api/v1/vaults/{_vaultId}/members/{_viewerId}");

        // viewer n'a plus accès
        var after = await _viewer.GetAsync($"/api/v1/vaults/{_vaultId}/documents");
        after.StatusCode.Should().Be(HttpStatusCode.NotFound);

        // Remettre viewer pour les autres tests
        await _owner.PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/members", new { userId = _viewerId, role = "viewer" });
    }

    // ── ACL-12 : Promotion viewer → editor débloque l'écriture ───────────────

    [Fact]
    public async Task ACL12_PromoteViewerToEditor_UnlocksWrite()
    {
        var uid = Guid.NewGuid().ToString("N")[..8];

        // Créer un nouveau viewer pour ce test (évite les interférences)
        var (tv2, uv2) = await _factory.CreateUserAndGetTokenAsync($"acl-prom-{uid}@test.com");
        var viewerClient = _factory.CreateClient();
        viewerClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", tv2);

        await _owner.PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/members", new { userId = uv2, role = "viewer" });

        // Viewer → 403 en écriture
        var blocked = await viewerClient.PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/documents",
            new { path = $"promote-{uid}.md", content = "#" });
        blocked.StatusCode.Should().Be(HttpStatusCode.Forbidden);

        // Retirer puis ré-ajouter comme editor
        await _owner.DeleteAsync($"/api/v1/vaults/{_vaultId}/members/{uv2}");
        await _owner.PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/members", new { userId = uv2, role = "editor" });

        // Editor → 201
        var allowed = await viewerClient.PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/documents",
            new { path = $"promote-{uid}.md", content = "# Promu" });
        allowed.StatusCode.Should().Be(HttpStatusCode.Created);
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

    // ── ACL-14 : Viewer peut lire le contenu d'un document ───────────────────

    [Fact]
    public async Task ACL14_Viewer_CanReadDocumentContent()
    {
        var doc = await OwnerCreateDocAsync("readable.md", "# Lisible par viewer");
        var resp = await _viewer.GetAsync(
            $"/api/v1/vaults/{_vaultId}/documents/{doc.Id}/content");
        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await resp.Content.ReadAsStringAsync();
        body.Should().Contain("Lisible par viewer");
    }

    // ── ACL-15 : Viewer peut lister les dossiers ─────────────────────────────

    [Fact]
    public async Task ACL15_Viewer_CanListFolders()
    {
        await OwnerCreateFolderAsync("ViewableFolder");
        var resp = await _viewer.GetAsync($"/api/v1/vaults/{_vaultId}/folders");
        resp.StatusCode.Should().Be(HttpStatusCode.OK);
    }
}
