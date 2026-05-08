// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Tests d'intégration — VaultHub
// Vérifie les événements SignalR de bout en bout sur le TestServer.

using System.Net.Http.Headers;
using System.Net.Http.Json;
using FluentAssertions;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.SignalR.Client;
using Savoire.Application.Common;
using Savoire.Server.Hubs;

namespace Savoire.Server.Integration.Tests.Hubs;

[Collection("Integration")]
public class VaultHubTests : IClassFixture<AppFactory>, IAsyncLifetime
{
    private readonly AppFactory _factory;
    private HttpClient _httpClient = null!;
    private string _vaultId = null!;
    private string _token   = null!;

    public VaultHubTests(AppFactory factory) => _factory = factory;

    public async Task InitializeAsync()
    {
        var uid = Guid.NewGuid().ToString("N")[..8];
        var (token, userId) = await _factory.CreateUserAndGetTokenAsync(
            $"hub-vault-{uid}@test.com", displayName: "Hub Vault User");
        _token = token;

        _httpClient = _factory.CreateClient();
        _httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);

        var vaultResp = await _httpClient.PostAsJsonAsync(
            $"/api/v1/users/{userId}/vaults", new { name = "VaultHub Integration Tests" });
        vaultResp.EnsureSuccessStatusCode();
        _vaultId = (await vaultResp.Content.ReadFromJsonAsync<VaultSummaryDto>())!.Id;
    }

    public Task DisposeAsync() => Task.CompletedTask;

    private HubConnection CreateConnection() =>
        new HubConnectionBuilder()
            .WithUrl("http://localhost/hubs/vault", options =>
            {
                options.HttpMessageHandlerFactory = _ => _factory.Server.CreateHandler();
                options.Transports = HttpTransportType.LongPolling;
                options.AccessTokenProvider = () => Task.FromResult<string?>(_token);
            })
            .Build();

    // ── JoinVault ─────────────────────────────────────────────────────────────

    [Fact]
    public async Task JoinVault_ReceivesVaultSnapshot()
    {
        await using HubConnection conn = CreateConnection();

        var tcs = new TaskCompletionSource<IEnumerable<VaultSnapshotItem>>();
        conn.On<IEnumerable<VaultSnapshotItem>>("VaultSnapshot", items => tcs.TrySetResult(items));

        await conn.StartAsync();
        await conn.InvokeAsync("JoinVault", _vaultId);

        var snapshot = await tcs.Task.WaitAsync(TimeSpan.FromSeconds(5));
        snapshot.Should().NotBeNull();
    }

    [Fact]
    public async Task JoinVault_AfterDocumentCreated_SnapshotContainsThatDocument()
    {
        await using HubConnection setup = CreateConnection();
        await setup.StartAsync();
        await setup.InvokeAsync("JoinVault", _vaultId);
        var existingDoc = await setup.InvokeAsync<VaultSnapshotItem>("CreateDocument", _vaultId, "snapshot-check.md", null);

        await using HubConnection conn = CreateConnection();

        var tcs = new TaskCompletionSource<IEnumerable<VaultSnapshotItem>>();
        conn.On<IEnumerable<VaultSnapshotItem>>("VaultSnapshot", items => tcs.TrySetResult(items));

        await conn.StartAsync();
        await conn.InvokeAsync("JoinVault", _vaultId);

        var snapshot = await tcs.Task.WaitAsync(TimeSpan.FromSeconds(5));
        snapshot.Should().Contain(item => item.Id == existingDoc.Id && item.Path == "snapshot-check.md");
    }

    // ── CreateDocument ────────────────────────────────────────────────────────

    [Fact]
    public async Task CreateDocument_BroadcastsDocumentCreated_ToAllClientsInVault()
    {
        await using HubConnection sender   = CreateConnection();
        await using HubConnection receiver = CreateConnection();

        var tcs = new TaskCompletionSource<DocumentCreatedEvent>();
        receiver.On<DocumentCreatedEvent>("DocumentCreated", evt => tcs.TrySetResult(evt));

        await sender.StartAsync();
        await receiver.StartAsync();

        await sender.InvokeAsync("JoinVault", _vaultId);
        await receiver.InvokeAsync("JoinVault", _vaultId);

        await sender.InvokeAsync("CreateDocument", _vaultId, "hub-created.md", "Hub Created");

        var evt = await tcs.Task.WaitAsync(TimeSpan.FromSeconds(5));
        evt.Path.Should().Be("hub-created.md");
        evt.Title.Should().BeNull();
        evt.VaultId.Should().Be(_vaultId);
    }

    [Fact]
    public async Task CreateDocument_SenderAlsoReceivesDocumentCreated()
    {
        await using HubConnection conn = CreateConnection();

        var tcs = new TaskCompletionSource<DocumentCreatedEvent>();
        conn.On<DocumentCreatedEvent>("DocumentCreated", evt => tcs.TrySetResult(evt));

        await conn.StartAsync();
        await conn.InvokeAsync("JoinVault", _vaultId);

        await conn.InvokeAsync("CreateDocument", _vaultId, "self-notify.md", null);

        var evt = await tcs.Task.WaitAsync(TimeSpan.FromSeconds(5));
        evt.Path.Should().Be("self-notify.md");
        evt.Title.Should().BeNull();
    }

    // ── RenameDocument ────────────────────────────────────────────────────────

    [Fact]
    public async Task RenameDocument_BroadcastsDocumentRenamed_WithOldAndNewPath()
    {
        await using HubConnection setup = CreateConnection();
        await setup.StartAsync();
        await setup.InvokeAsync("JoinVault", _vaultId);
        var doc = await setup.InvokeAsync<VaultSnapshotItem>("CreateDocument", _vaultId, "before-rename.md", null);

        await using HubConnection conn = CreateConnection();

        var tcs = new TaskCompletionSource<DocumentRenamedEvent>();
        conn.On<DocumentRenamedEvent>("DocumentRenamed", evt => tcs.TrySetResult(evt));

        await conn.StartAsync();
        await conn.InvokeAsync("JoinVault", _vaultId);

        await conn.InvokeAsync("RenameDocument", doc.Id, "after-rename.md");

        var evt = await tcs.Task.WaitAsync(TimeSpan.FromSeconds(5));
        evt.Id.Should().Be(doc.Id);
        evt.OldPath.Should().Be("before-rename.md");
        evt.NewPath.Should().Be("after-rename.md");
    }

    // ── DeleteDocument ────────────────────────────────────────────────────────

    [Fact]
    public async Task DeleteDocument_BroadcastsDocumentDeleted_WithDocumentPath()
    {
        await using HubConnection setup = CreateConnection();
        await setup.StartAsync();
        await setup.InvokeAsync("JoinVault", _vaultId);
        var doc = await setup.InvokeAsync<VaultSnapshotItem>("CreateDocument", _vaultId, "to-delete.md", null);

        await using HubConnection conn = CreateConnection();

        var tcs = new TaskCompletionSource<DocumentDeletedEvent>();
        conn.On<DocumentDeletedEvent>("DocumentDeleted", evt => tcs.TrySetResult(evt));

        await conn.StartAsync();
        await conn.InvokeAsync("JoinVault", _vaultId);

        await conn.InvokeAsync("DeleteDocument", doc.Id);

        var evt = await tcs.Task.WaitAsync(TimeSpan.FromSeconds(5));
        evt.Id.Should().Be(doc.Id);
        evt.Path.Should().Be("to-delete.md");
        evt.DeletedAt.Should().BeCloseTo(DateTime.UtcNow, TimeSpan.FromSeconds(5));
    }

    // ── Isolation de groupe ───────────────────────────────────────────────────

    // ── Auth ──────────────────────────────────────────────────────────────────

    [Fact(DisplayName = "VaultHub — connexion sans token est refusée (401)")]
    public async Task JoinVault_WithoutToken_ConnectionFails()
    {
        await using var conn = new HubConnectionBuilder()
            .WithUrl("http://localhost/hubs/vault", options =>
            {
                options.HttpMessageHandlerFactory = _ => _factory.Server.CreateHandler();
                options.Transports = HttpTransportType.LongPolling;
            })
            .Build();

        var act = () => conn.StartAsync();
        await act.Should().ThrowAsync<Exception>();
    }

    // ── CreateDocument — valeur de retour ─────────────────────────────────────

    [Fact(DisplayName = "CreateDocument — retourne le VaultSnapshotItem créé")]
    public async Task CreateDocument_ReturnsVaultSnapshotItem()
    {
        await using HubConnection conn = CreateConnection();
        await conn.StartAsync();
        await conn.InvokeAsync("JoinVault", _vaultId);

        var path = $"ret-doc-{Guid.NewGuid():N}.md";
        var item = await conn.InvokeAsync<VaultSnapshotItem>("CreateDocument", _vaultId, path, null);

        item.Should().NotBeNull();
        item.Path.Should().Be(path);
        item.Id.Should().NotBeNullOrEmpty();
    }

    [Fact(DisplayName = "CreateDocument — chemin dupliqué lève HubException avec préfixe 409")]
    public async Task CreateDocument_DuplicatePath_ThrowsHubException409()
    {
        await using HubConnection conn = CreateConnection();
        await conn.StartAsync();
        await conn.InvokeAsync("JoinVault", _vaultId);

        var path = $"dup-{Guid.NewGuid():N}.md";
        await conn.InvokeAsync<VaultSnapshotItem>("CreateDocument", _vaultId, path, null);

        var act = () => conn.InvokeAsync<VaultSnapshotItem>("CreateDocument", _vaultId, path, null);
        await act.Should().ThrowAsync<Exception>().WithMessage("*409*");
    }

    // ── PushIndexOp ───────────────────────────────────────────────────────────

    [Fact(DisplayName = "PushIndexOp — retourne un numéro de séquence positif")]
    public async Task PushIndexOp_ReturnsSequenceNumber()
    {
        await using HubConnection setup = CreateConnection();
        await setup.StartAsync();
        await setup.InvokeAsync("JoinVault", _vaultId);
        var doc = await setup.InvokeAsync<VaultSnapshotItem>("CreateDocument", _vaultId, "index-seq.md", null);

        await using HubConnection conn = CreateConnection();
        await conn.StartAsync();
        await conn.InvokeAsync("JoinVault", _vaultId);

        var dto = new PushIndexOpDto(_vaultId, doc.Id, doc.Path, "# Hello index");
        long seq = await conn.InvokeAsync<long>("PushIndexOp", dto);

        seq.Should().BePositive();
    }

    [Fact(DisplayName = "PushIndexOp — diffuse IndexOpApplied aux autres clients du vault")]
    public async Task PushIndexOp_BroadcastsIndexOpAppliedToOtherClients()
    {
        await using HubConnection setup = CreateConnection();
        await setup.StartAsync();
        await setup.InvokeAsync("JoinVault", _vaultId);
        var doc = await setup.InvokeAsync<VaultSnapshotItem>("CreateDocument", _vaultId, "index-broadcast.md", null);

        await using HubConnection sender   = CreateConnection();
        await using HubConnection receiver = CreateConnection();

        var tcs = new TaskCompletionSource<IndexOpAppliedEvent>();
        receiver.On<IndexOpAppliedEvent>("IndexOpApplied", evt => tcs.TrySetResult(evt));

        await sender.StartAsync();
        await receiver.StartAsync();

        await sender.InvokeAsync("JoinVault", _vaultId);
        await receiver.InvokeAsync("JoinVault", _vaultId);

        var dto = new PushIndexOpDto(_vaultId, doc.Id, doc.Path, "# Broadcast test");
        await sender.InvokeAsync<long>("PushIndexOp", dto);

        var evt = await tcs.Task.WaitAsync(TimeSpan.FromSeconds(5));
        evt.DocId.Should().Be(doc.Id);
        evt.MarkdownContent.Should().Be("# Broadcast test");
        evt.Seq.Should().BePositive();
    }

    [Fact]
    public async Task CreateDocument_ClientNotInVault_DoesNotReceiveEvent()
    {
        await using HubConnection sender    = CreateConnection();
        await using HubConnection outsider  = CreateConnection();

        bool outsiderReceived = false;
        outsider.On<DocumentCreatedEvent>("DocumentCreated", _ => outsiderReceived = true);

        await sender.StartAsync();
        await outsider.StartAsync();

        // outsider n'a accès à aucun vault — JoinVault avec un ID inconnu lève une exception
        await sender.InvokeAsync("JoinVault", _vaultId);
        try { await outsider.InvokeAsync("JoinVault", "other-vault-id"); }
        catch { /* vault inexistant — attendu : outsider ne rejoint aucun groupe */ }

        await sender.InvokeAsync("CreateDocument", _vaultId, "isolated.md", null);

        // Attendre un court délai pour s'assurer qu'aucun événement ne fuite
        await Task.Delay(300);
        outsiderReceived.Should().BeFalse();
    }
}
