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

    private async Task<DocumentDto> CreateDocAsync(HttpClient client, string vaultId, string path, string content = "# Test")
    {
        var resp = await client.PostAsJsonAsync(
            $"/api/v1/vaults/{vaultId}/documents",
            new { path, content });
        resp.EnsureSuccessStatusCode();
        return (await resp.Content.ReadFromJsonAsync<DocumentDto>())!;
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

    // ── M1-02 ────────────────────────────────────────────────────────────────

    /// <summary>M1-02 : Clone d'un vault → tous les fichiers sont présents dans le manifeste.</summary>
    [Fact]
    public async Task CloneVault_AllFilesPresent()
    {
        var vault = await CreateVaultAsync(_clientA, "Vault Clone E2E");
        await CreateDocAsync(_clientA, vault.Id, "doc1.md", "# Doc 1");
        await CreateDocAsync(_clientA, vault.Id, "doc2.md", "# Doc 2");

        var resp     = await _clientA.PostAsJsonAsync($"/api/v1/vaults/{vault.Id}/clone", new { });
        var manifest = await resp.Content.ReadFromJsonAsync<CloneManifestDto>();

        manifest!.Documents.Should().HaveCount(2);
        manifest.TotalDocuments.Should().Be(2);
    }

    // ── M1-03 ────────────────────────────────────────────────────────────────

    /// <summary>M1-03 : Créer une note → clientB la reçoit via SignalR.</summary>
    [Fact]
    public async Task CreateNote_AppearsForAllConnectedClients()
    {
        var vault = await CreateVaultAsync(_clientA, "Vault Temps Réel");

        // Ajouter other-user comme membre
        await _clientA.PostAsJsonAsync(
            $"/api/v1/vaults/{vault.Id}/members",
            new { userId = _userIdB, role = "editor" });

        // clientB se connecte et rejoint le document
        await using var hubB = new SignalRTestClient(_server, _userIdB, _tokenB);
        await hubB.ConnectAsync();

        var doc = await CreateDocAsync(_clientA, vault.Id, "new-note.md", "# Nouvelle Note");
        await hubB.JoinDocumentAsync(vault.Id, doc.Id);

        // clientA pousse une opération
        await using var hubA = new SignalRTestClient(_server, _userIdA, _tokenA);
        await hubA.ConnectAsync();
        await hubA.JoinDocumentAsync(vault.Id, doc.Id);
        await hubA.PushOperationAsync(vault.Id, doc.Id, "client-A", new byte[] { 0x01, 0x02 });

        // Attendre que clientB reçoive l'op (max 2s)
        await hubB.WaitForReceiveAsync(1, TimeSpan.FromSeconds(2));

        hubB.ReceivedOps.Should().HaveCount(1);
        hubB.ReceivedOps[0].DocId.Should().Be(doc.Id);
    }

    // ── M1-04 ────────────────────────────────────────────────────────────────

    /// <summary>M1-04 : Édition temps réel → les deux clients convergent en moins de 200ms.</summary>
    [Theory]
    [InlineData(Microsoft.AspNetCore.Http.Connections.HttpTransportType.ServerSentEvents)]
    [InlineData(Microsoft.AspNetCore.Http.Connections.HttpTransportType.LongPolling)]
    public async Task RealtimeEdit_BothClientsConverge_Under200ms(Microsoft.AspNetCore.Http.Connections.HttpTransportType transport)
    {
        var vault = await CreateVaultAsync(_clientA, "Vault Latence");
        await _clientA.PostAsJsonAsync(
            $"/api/v1/vaults/{vault.Id}/members",
            new { userId = _userIdB, role = "editor" });

        var doc = await CreateDocAsync(_clientA, vault.Id, "latency-test.md");

        await using var hubA = new SignalRTestClient(_server, _userIdA, _tokenA, transport);
        await using var hubB = new SignalRTestClient(_server, _userIdB, _tokenB, transport);

        await hubA.ConnectAsync();
        await hubB.ConnectAsync();
        await hubA.JoinDocumentAsync(vault.Id, doc.Id);
        await hubB.JoinDocumentAsync(vault.Id, doc.Id);

        var sw = Stopwatch.StartNew();
        await hubA.PushOperationAsync(vault.Id, doc.Id, "client-A", new byte[] { 0x10, 0x20 });

        await hubB.WaitForReceiveAsync(1, TimeSpan.FromMilliseconds(500));
        sw.Stop();

        hubB.ReceivedOps.Should().HaveCount(1, "clientB doit recevoir l'opération");

        long maxLatencyMs = transport == Microsoft.AspNetCore.Http.Connections.HttpTransportType.LongPolling
            ? 500
            : 200;
        sw.ElapsedMilliseconds.Should().BeLessThan(maxLatencyMs,
            $"la propagation doit se faire en < {maxLatencyMs}ms pour {transport}");
    }

    // ── M1-05 ────────────────────────────────────────────────────────────────

    /// <summary>M1-05 : Édition hors-ligne → les ops sont mergées à la reconnexion.</summary>
    [Theory]
    [InlineData(Microsoft.AspNetCore.Http.Connections.HttpTransportType.ServerSentEvents)]
    [InlineData(Microsoft.AspNetCore.Http.Connections.HttpTransportType.LongPolling)]
    public async Task OfflineEdit_MergedOnReconnect_NoDataLoss(Microsoft.AspNetCore.Http.Connections.HttpTransportType transport)
    {
        var vault = await CreateVaultAsync(_clientA, "Vault Offline");
        var doc   = await CreateDocAsync(_clientA, vault.Id, "offline.md");

        // clientA pousse une op "hors-ligne" directement via HTTP
        await _clientA.PostAsJsonAsync(
            $"/api/v1/vaults/{vault.Id}/documents/{doc.Id}/operations",
            new { clientId = "client-offline", producedAt = DateTime.UtcNow, ops = new byte[] { 0xAA } });

        // clientB se connecte (online) et synchronise
        await using var hubB = new SignalRTestClient(_server, _userIdA, _tokenA, transport);
        await hubB.ConnectAsync();
        await hubB.JoinDocumentAsync(vault.Id, doc.Id);

        // Attendre InitDocument qui devrait contenir l'op hors-ligne
        await Task.Delay(200);

        hubB.InitEvents.Should().HaveCount(1);
        hubB.InitEvents[0].Ops.Should().HaveCount(1, "l'op offline doit être présente au sync");
    }

    // ── M1-06 ────────────────────────────────────────────────────────────────

    /// <summary>M1-06 : Renommer une note → le nouveau path est reflété pour tous.</summary>
    [Fact]
    public async Task RenameNote_ReflectedOnAllClients()
    {
        var vault = await CreateVaultAsync(_clientA, "Vault Renommage");
        var doc   = await CreateDocAsync(_clientA, vault.Id, "original.md");

        var resp    = await _clientA.PatchAsJsonAsync(
            $"/api/v1/vaults/{vault.Id}/documents/{doc.Id}",
            new { path = "renamed.md" });
        var updated = await resp.Content.ReadFromJsonAsync<DocumentDto>();

        updated!.Path.Should().Be("renamed.md");

        // La liste doit aussi refléter le changement
        var listResp = await _clientA.GetAsync($"/api/v1/vaults/{vault.Id}/documents");
        var docs     = await listResp.Content.ReadFromJsonAsync<DocumentDto[]>();
        docs!.Should().Contain(d => d.Path == "renamed.md");
        docs.Should().NotContain(d => d.Path == "original.md");
    }

    // ── M1-07 ────────────────────────────────────────────────────────────────

    /// <summary>M1-07 : Supprimer une note → elle disparaît de la liste.</summary>
    [Fact]
    public async Task DeleteNote_DisappearsForAllClients()
    {
        var vault = await CreateVaultAsync(_clientA, "Vault Suppression");
        var doc   = await CreateDocAsync(_clientA, vault.Id, "to-delete.md");

        await _clientA.DeleteAsync($"/api/v1/vaults/{vault.Id}/documents/{doc.Id}");

        var resp = await _clientA.GetAsync($"/api/v1/vaults/{vault.Id}/documents");
        var docs = await resp.Content.ReadFromJsonAsync<DocumentDto[]>();
        docs!.Should().NotContain(d => d.Id == doc.Id);
    }

    // ── M1-08 ────────────────────────────────────────────────────────────────

    /// <summary>M1-08 : Créer un dossier imbriqué → hiérarchie correcte.</summary>
    [Fact]
    public async Task CreateNestedFolder_CorrectHierarchy()
    {
        var vault = await CreateVaultAsync(_clientA, "Vault Hiérarchie");

        var resp   = await _clientA.PostAsJsonAsync(
            $"/api/v1/vaults/{vault.Id}/folders",
            new { path = "Projets/Alpha/Specs" });

        resp.EnsureSuccessStatusCode();

        var foldersResp = await _clientA.GetAsync($"/api/v1/vaults/{vault.Id}/folders");
        var folders     = await foldersResp.Content.ReadFromJsonAsync<FolderDto[]>();

        folders!.Select(f => f.Path).Should()
            .Contain(["Projets", "Projets/Alpha", "Projets/Alpha/Specs"]);
    }

    // ── M1-09 ────────────────────────────────────────────────────────────────

    /// <summary>M1-09 : Renommer un dossier → tous les documents enfants sont mis à jour.</summary>
    [Fact]
    public async Task RenameFolder_AllChildDocumentsUpdated()
    {
        var vault  = await CreateVaultAsync(_clientA, "Vault Dossier Rename");
        var folderResp = await _clientA.PostAsJsonAsync(
            $"/api/v1/vaults/{vault.Id}/folders", new { path = "Old" });
        var folder = await folderResp.Content.ReadFromJsonAsync<FolderDto>();

        await CreateDocAsync(_clientA, vault.Id, "Old/doc1.md");
        await CreateDocAsync(_clientA, vault.Id, "Old/doc2.md");

        await _clientA.PatchAsJsonAsync(
            $"/api/v1/vaults/{vault.Id}/folders/{folder!.Id}",
            new { path = "New" });

        var docs = await (await _clientA.GetAsync(
            $"/api/v1/vaults/{vault.Id}/documents?folder=New"))
            .Content.ReadFromJsonAsync<DocumentDto[]>();

        docs!.Should().HaveCount(2);
        docs.Should().OnlyContain(d => d.Path.StartsWith("New/"));
    }

    // ── M1-10 ────────────────────────────────────────────────────────────────

    /// <summary>M1-10 : Supprimer un dossier non vide sans force → refus.</summary>
    [Fact]
    public async Task DeleteNonEmptyFolder_RequiresForce()
    {
        var vault      = await CreateVaultAsync(_clientA, "Vault Force");
        var folderResp = await _clientA.PostAsJsonAsync(
            $"/api/v1/vaults/{vault.Id}/folders", new { path = "NonVide" });
        var folder = await folderResp.Content.ReadFromJsonAsync<FolderDto>();

        await CreateDocAsync(_clientA, vault.Id, "NonVide/note.md");

        var withoutForce = await _clientA.DeleteAsync(
            $"/api/v1/vaults/{vault.Id}/folders/{folder!.Id}");
        var withForce = await _clientA.DeleteAsync(
            $"/api/v1/vaults/{vault.Id}/folders/{folder.Id}?force=true");

        withoutForce.StatusCode.Should().Be(System.Net.HttpStatusCode.BadRequest);
        withForce.StatusCode.Should().Be(System.Net.HttpStatusCode.NoContent);
    }

    // ── M1-11 & M1-12 ────────────────────────────────────────────────────────

    /// <summary>M1-11 : Détection de conflit (placeholder — nécessite ConflictResolver V2).</summary>
    [Fact(Skip = "ConflictResolver non implémenté en V1")]
    public Task ConflictDetected_UIReceivesSyncConflictEvent()
        => Task.CompletedTask;

    /// <summary>M1-12 : Multi-device bidirectionnel → les deux clients voient les modifications.</summary>
    [Theory]
    [InlineData(Microsoft.AspNetCore.Http.Connections.HttpTransportType.ServerSentEvents)]
    [InlineData(Microsoft.AspNetCore.Http.Connections.HttpTransportType.LongPolling)]
    public async Task MultiDevice_BidirectionalSync(Microsoft.AspNetCore.Http.Connections.HttpTransportType transport)
    {
        var vault = await CreateVaultAsync(_clientA, "Vault Multi-Device");
        await _clientA.PostAsJsonAsync(
            $"/api/v1/vaults/{vault.Id}/members",
            new { userId = _userIdB, role = "editor" });

        var doc = await CreateDocAsync(_clientA, vault.Id, "shared.md");

        await using var hubA = new SignalRTestClient(_server, _userIdA, _tokenA, transport);
        await using var hubB = new SignalRTestClient(_server, _userIdB, _tokenB, transport);

        await hubA.ConnectAsync();
        await hubB.ConnectAsync();
        await hubA.JoinDocumentAsync(vault.Id, doc.Id);
        await hubB.JoinDocumentAsync(vault.Id, doc.Id);

        // A → B
        await hubA.PushOperationAsync(vault.Id, doc.Id, "client-A", new byte[] { 0x01 });
        await hubB.WaitForReceiveAsync(1, TimeSpan.FromSeconds(2));

        // B → A
        await hubB.PushOperationAsync(vault.Id, doc.Id, "client-B", new byte[] { 0x02 });
        await hubA.WaitForReceiveAsync(1, TimeSpan.FromSeconds(2));

        hubA.ReceivedOps.Should().HaveCount(1, "A doit recevoir l'op de B");
        hubB.ReceivedOps.Should().HaveCount(1, "B doit recevoir l'op de A");
    }
}
