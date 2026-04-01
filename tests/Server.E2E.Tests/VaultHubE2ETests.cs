// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Tests E2E — VaultHub (vault + file operations)
//
// Scénarios couverts :
//   VH-01  JoinVault → VaultSnapshot avec les docs existants
//   VH-02  JoinVault vault vide → VaultSnapshot vide
//   VH-03  REST CreateDocument → tous les clients reçoivent DocumentCreated
//   VH-04  VaultHub.CreateDocument → retourne l'item + broadcast DocumentCreated
//   VH-05  VaultHub.RenameDocument → broadcast DocumentRenamed sur le vault
//   VH-06  VaultHub.DeleteDocument → broadcast DocumentDeleted sur le vault
//   VH-07  Deux clients dans le même vault → les deux reçoivent les événements
//   VH-08  Client dans un autre vault → ne reçoit pas les événements
//   VH-09  VaultHub sans token → refus 401
//   VH-10  Cycle complet : connect → create → rename → delete
//   VH-11  Reconnexion auto → vault rejoint, snapshot reçu

using System.Diagnostics;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using FluentAssertions;
using Savoire.Server.Integration.Tests;
using Savoire.Server.Models.Dto;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.SignalR.Client;

namespace Savoire.Server.E2E.Tests;

[Collection("E2E")]
public class VaultHubE2ETests : IAsyncLifetime
{
    private AppFactory _server = null!;
    private HttpClient _clientA = null!;
    private HttpClient _clientB = null!;
    private string     _userIdA = null!;
    private string     _userIdB = null!;
    private string     _tokenA  = null!;
    private string     _tokenB  = null!;

    public async Task InitializeAsync()
    {
        _server = new AppFactory();
        var uid = Guid.NewGuid().ToString("N")[..8];

        (_tokenA, _userIdA) = await _server.CreateUserAndGetTokenAsync(
            $"vh-a-{uid}@test.com", displayName: "VH User A");
        _clientA = _server.CreateClient();
        _clientA.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", _tokenA);

        (_tokenB, _userIdB) = await _server.CreateUserAndGetTokenAsync(
            $"vh-b-{uid}@test.com", displayName: "VH User B");
        _clientB = _server.CreateClient();
        _clientB.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", _tokenB);
    }

    public async Task DisposeAsync()
    {
        _clientA.Dispose();
        _clientB.Dispose();
        await _server.DisposeAsync();
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private async Task<VaultSummaryDto> CreateVaultAsync(HttpClient client, string userId, string name)
    {
        var resp = await client.PostAsJsonAsync($"/api/v1/users/{userId}/vaults", new { name });
        resp.EnsureSuccessStatusCode();
        return (await resp.Content.ReadFromJsonAsync<VaultSummaryDto>())!;
    }

    private async Task<DocumentDto> RestCreateDocAsync(HttpClient client, string vaultId, string path, string content = "# Test")
    {
        var resp = await client.PostAsJsonAsync(
            $"/api/v1/vaults/{vaultId}/documents", new { path, content });
        resp.EnsureSuccessStatusCode();
        return (await resp.Content.ReadFromJsonAsync<DocumentDto>())!;
    }

    private VaultHubTestClient HubA(HttpTransportType t = HttpTransportType.ServerSentEvents)
        => new(_server, _tokenA, t);

    private VaultHubTestClient HubB(HttpTransportType t = HttpTransportType.ServerSentEvents)
        => new(_server, _tokenB, t);

    // ── VH-01 : JoinVault → snapshot avec documents ───────────────────────────

    [Fact]
    public async Task VH01_JoinVault_WithDocuments_ReceivesSnapshot()
    {
        var vault = await CreateVaultAsync(_clientA, _userIdA, "Vault Snapshot");
        await RestCreateDocAsync(_clientA, vault.Id, "note1.md");
        await RestCreateDocAsync(_clientA, vault.Id, "note2.md");

        await using var hub = HubA();
        await hub.ConnectAsync();
        await hub.JoinVaultAsync(vault.Id);
        await hub.WaitForSnapshotAsync();

        hub.Snapshots.Should().HaveCountGreaterThanOrEqualTo(2);
        hub.Snapshots.Should().Contain(s => s.Path == "note1.md");
        hub.Snapshots.Should().Contain(s => s.Path == "note2.md");
    }

    // ── VH-02 : JoinVault vault vide → snapshot vide ──────────────────────────

    [Fact]
    public async Task VH02_JoinVault_Empty_ReceivesEmptySnapshot()
    {
        var vault = await CreateVaultAsync(_clientA, _userIdA, "Vault Vide");

        await using var hub = HubA();
        await hub.ConnectAsync();
        await hub.JoinVaultAsync(vault.Id);
        await hub.WaitForSnapshotAsync();

        hub.Snapshots.Should().BeEmpty();
    }

    // ── VH-03 : REST CreateDocument → broadcast DocumentCreated ──────────────

    [Fact]
    public async Task VH03_REST_CreateDocument_BroadcastsDocumentCreated()
    {
        var vault = await CreateVaultAsync(_clientA, _userIdA, "Vault REST Broadcast");
        await _clientA.PostAsJsonAsync(
            $"/api/v1/vaults/{vault.Id}/members", new { userId = _userIdB, role = "editor" });

        await using var hubB = HubB();
        await hubB.ConnectAsync();
        await hubB.JoinVaultAsync(vault.Id);
        await hubB.WaitForSnapshotAsync(); // attendre snapshot initial

        // REST create par A → hubB doit recevoir l'événement
        await RestCreateDocAsync(_clientA, vault.Id, "from-rest.md", "# REST");
        await hubB.WaitForCreatedAsync(1);

        hubB.CreatedEvents.Should().HaveCount(1);
        hubB.CreatedEvents[0].Path.Should().Be("from-rest.md");
        hubB.CreatedEvents[0].VaultId.Should().Be(vault.Id);
    }

    // ── VH-04 : VaultHub.CreateDocument → retourne item + broadcast ──────────

    [Fact]
    public async Task VH04_Hub_CreateDocument_ReturnsItem_AndBroadcasts()
    {
        var vault = await CreateVaultAsync(_clientA, _userIdA, "Vault Hub Create");
        await _clientA.PostAsJsonAsync(
            $"/api/v1/vaults/{vault.Id}/members", new { userId = _userIdB, role = "editor" });

        await using var hubA = HubA();
        await using var hubB = HubB();
        await hubA.ConnectAsync();
        await hubB.ConnectAsync();
        await hubA.JoinVaultAsync(vault.Id);
        await hubB.JoinVaultAsync(vault.Id);
        await hubA.WaitForSnapshotAsync();
        await hubB.WaitForSnapshotAsync();

        // A crée un doc via hub
        var item = await hubA.CreateDocumentAsync(vault.Id, "hub-created.md", "Hub Doc");

        // A reçoit le retour immédiat
        item.Path.Should().Be("hub-created.md");
        item.Id.Should().NotBeNullOrEmpty();

        // B reçoit le broadcast
        await hubB.WaitForCreatedAsync(1);
        hubB.CreatedEvents[0].Path.Should().Be("hub-created.md");
    }

    // ── VH-05 : VaultHub.RenameDocument → broadcast DocumentRenamed ──────────

    [Fact]
    public async Task VH05_Hub_RenameDocument_BroadcastsDocumentRenamed()
    {
        var vault = await CreateVaultAsync(_clientA, _userIdA, "Vault Rename Broadcast");
        await _clientA.PostAsJsonAsync(
            $"/api/v1/vaults/{vault.Id}/members", new { userId = _userIdB, role = "editor" });

        // Créer un doc via REST
        var doc = await RestCreateDocAsync(_clientA, vault.Id, "old-name.md");

        await using var hubA = HubA();
        await using var hubB = HubB();
        await hubA.ConnectAsync();
        await hubB.ConnectAsync();
        await hubA.JoinVaultAsync(vault.Id);
        await hubB.JoinVaultAsync(vault.Id);
        await hubA.WaitForSnapshotAsync();
        await hubB.WaitForSnapshotAsync();

        // A renomme
        await hubA.RenameDocumentAsync(doc.Id, "new-name.md");

        // B reçoit l'événement
        await hubB.WaitForRenamedAsync(1);
        hubB.RenamedEvents[0].Id.Should().Be(doc.Id);
        hubB.RenamedEvents[0].OldPath.Should().Be("old-name.md");
        hubB.RenamedEvents[0].NewPath.Should().Be("new-name.md");
    }

    // ── VH-06 : VaultHub.DeleteDocument → broadcast DocumentDeleted ──────────

    [Fact]
    public async Task VH06_Hub_DeleteDocument_BroadcastsDocumentDeleted()
    {
        var vault = await CreateVaultAsync(_clientA, _userIdA, "Vault Delete Broadcast");
        await _clientA.PostAsJsonAsync(
            $"/api/v1/vaults/{vault.Id}/members", new { userId = _userIdB, role = "editor" });

        var doc = await RestCreateDocAsync(_clientA, vault.Id, "to-delete.md");

        await using var hubA = HubA();
        await using var hubB = HubB();
        await hubA.ConnectAsync();
        await hubB.ConnectAsync();
        await hubA.JoinVaultAsync(vault.Id);
        await hubB.JoinVaultAsync(vault.Id);
        await hubA.WaitForSnapshotAsync();
        await hubB.WaitForSnapshotAsync();

        await hubA.DeleteDocumentAsync(doc.Id);

        await hubB.WaitForDeletedAsync(1);
        hubB.DeletedEvents[0].Id.Should().Be(doc.Id);
        hubB.DeletedEvents[0].Path.Should().Be("to-delete.md");
    }

    // ── VH-07 : Deux clients même vault → les deux reçoivent les événements ──

    [Theory]
    [InlineData(HttpTransportType.ServerSentEvents)]
    [InlineData(HttpTransportType.LongPolling)]
    public async Task VH07_TwoClients_SameVault_BothReceiveEvents(HttpTransportType transport)
    {
        var vault = await CreateVaultAsync(_clientA, _userIdA, $"Vault 2-Clients {transport}");
        await _clientA.PostAsJsonAsync(
            $"/api/v1/vaults/{vault.Id}/members", new { userId = _userIdB, role = "editor" });

        await using var hubA = HubA(transport);
        await using var hubB = HubB(transport);
        await hubA.ConnectAsync();
        await hubB.ConnectAsync();
        await hubA.JoinVaultAsync(vault.Id);
        await hubB.JoinVaultAsync(vault.Id);
        await hubA.WaitForSnapshotAsync();
        await hubB.WaitForSnapshotAsync();

        var sw = Stopwatch.StartNew();

        // A crée via REST → les deux doivent être notifiés
        await RestCreateDocAsync(_clientA, vault.Id, "shared.md");

        await Task.WhenAll(
            hubA.WaitForCreatedAsync(1),
            hubB.WaitForCreatedAsync(1));

        sw.Stop();

        hubA.CreatedEvents.Should().HaveCount(1, "A doit recevoir DocumentCreated");
        hubB.CreatedEvents.Should().HaveCount(1, "B doit recevoir DocumentCreated");

        long maxMs = transport == HttpTransportType.LongPolling ? 500 : 200;
        sw.ElapsedMilliseconds.Should().BeLessThan(maxMs,
            $"propagation < {maxMs}ms pour {transport}");
    }

    // ── VH-08 : Client dans un autre vault → ne reçoit pas les événements ────

    [Fact]
    public async Task VH08_ClientInOtherVault_DoesNotReceiveEvents()
    {
        var vaultA = await CreateVaultAsync(_clientA, _userIdA, "Vault Isolé A");
        var vaultB = await CreateVaultAsync(_clientB, _userIdB, "Vault Isolé B");

        await using var hubA = HubA();
        await using var hubB = HubB();
        await hubA.ConnectAsync();
        await hubB.ConnectAsync();
        await hubA.JoinVaultAsync(vaultA.Id);
        await hubB.JoinVaultAsync(vaultB.Id);
        await hubA.WaitForSnapshotAsync();
        await hubB.WaitForSnapshotAsync();

        // A crée un doc dans son vault → B ne doit PAS recevoir d'événement
        await RestCreateDocAsync(_clientA, vaultA.Id, "private.md");
        await Task.Delay(200); // laisser le temps de propager si bug

        hubB.CreatedEvents.Should().BeEmpty("B est dans un vault différent");
    }

    // ── VH-09 : VaultHub sans token → 401 ────────────────────────────────────

    [Fact]
    public async Task VH09_ConnectWithoutToken_Fails()
    {
        await using var hubNoAuth = new HubConnectionBuilder()
            .WithUrl("http://localhost/hubs/vault", options =>
            {
                options.HttpMessageHandlerFactory = _ => _server.Server.CreateHandler();
                options.Transports = HttpTransportType.ServerSentEvents;
            })
            .Build();

        var act = async () => await hubNoAuth.StartAsync();

        await act.Should().ThrowAsync<Exception>("connexion sans token doit échouer");
    }

    // ── VH-10 : Cycle complet connect → create → rename → delete ─────────────

    [Fact]
    public async Task VH10_FullLifecycle_CreateRenameDelete()
    {
        var vault = await CreateVaultAsync(_clientA, _userIdA, "Vault Lifecycle");

        await using var hub = HubA();
        await hub.ConnectAsync();
        await hub.JoinVaultAsync(vault.Id);
        await hub.WaitForSnapshotAsync();

        // Create
        var item = await hub.CreateDocumentAsync(vault.Id, "lifecycle.md");
        item.Id.Should().NotBeNullOrEmpty();
        item.Path.Should().Be("lifecycle.md");

        // Rename
        await hub.RenameDocumentAsync(item.Id, "lifecycle-renamed.md");
        await hub.WaitForRenamedAsync(1);
        hub.RenamedEvents[0].NewPath.Should().Be("lifecycle-renamed.md");

        // Delete
        await hub.DeleteDocumentAsync(item.Id);
        await hub.WaitForDeletedAsync(1);
        hub.DeletedEvents[0].Id.Should().Be(item.Id);

        // Vérification finale via REST
        var resp = await _clientA.GetAsync($"/api/v1/vaults/{vault.Id}/documents");
        var docs = await resp.Content.ReadFromJsonAsync<DocumentDto[]>();
        docs!.Should().NotContain(d => d.Id == item.Id);
    }

    // ── VH-11 : Snapshot reflète l'état courant après plusieurs créations ─────

    [Fact]
    public async Task VH11_Snapshot_ReflectsCurrentState()
    {
        var vault = await CreateVaultAsync(_clientA, _userIdA, "Vault Snapshot State");
        await RestCreateDocAsync(_clientA, vault.Id, "existing-1.md");
        await RestCreateDocAsync(_clientA, vault.Id, "existing-2.md");
        await RestCreateDocAsync(_clientA, vault.Id, "existing-3.md");

        await using var hub = HubA();
        await hub.ConnectAsync();
        await hub.JoinVaultAsync(vault.Id);
        await hub.WaitForSnapshotAsync();

        hub.Snapshots.Should().HaveCountGreaterThanOrEqualTo(3);
        hub.Snapshots.Select(s => s.Path).Should()
            .Contain(["existing-1.md", "existing-2.md", "existing-3.md"]);
    }
}
