// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Tests d'intégration — SyncHub (/hubs/sync)
// Stabilise le comportement observable avant refacto MediatR.
// Chaque test couvre une méthode du hub et vérifie le contrat client/serveur.

using System.Net.Http.Headers;
using System.Net.Http.Json;
using FluentAssertions;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.SignalR.Client;
using Savoire.Application.Common;

namespace Savoire.Server.Integration.Tests.Hubs;

[Collection("Integration")]
public class SyncHubTests : IClassFixture<AppFactory>, IAsyncLifetime
{
    private readonly AppFactory _factory;
    private HttpClient _httpClient = null!;
    private string _vaultId = null!;
    private string _docId   = null!;
    private string _token   = null!;

    public SyncHubTests(AppFactory factory) => _factory = factory;

    public async Task InitializeAsync()
    {
        var uid = Guid.NewGuid().ToString("N")[..8];
        var (token, userId) = await _factory.CreateUserAndGetTokenAsync(
            $"sync-hub-{uid}@test.com", displayName: "Sync Hub User");
        _token = token;

        _httpClient = _factory.CreateClient();
        _httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);

        // Créer un vault de test
        var vaultResp = await _httpClient.PostAsJsonAsync(
            $"/api/v1/users/{userId}/vaults", new { name = $"SyncHub Tests {uid}" });
        vaultResp.EnsureSuccessStatusCode();
        _vaultId = (await vaultResp.Content.ReadFromJsonAsync<VaultSummaryDto>())!.Id;

        // Créer un document de test via REST
        var docResp = await _httpClient.PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/documents",
            new { path = "test-doc.md", content = "# Hello" });
        docResp.EnsureSuccessStatusCode();
        _docId = (await docResp.Content.ReadFromJsonAsync<DocumentDto>())!.Id;
    }

    public Task DisposeAsync() => Task.CompletedTask;

    private HubConnection CreateConnection(string? userId = null) =>
        new HubConnectionBuilder()
            .WithUrl($"http://localhost/hubs/sync?userId={userId ?? "test-user"}", options =>
            {
                options.HttpMessageHandlerFactory = _ => _factory.Server.CreateHandler();
                options.Transports = HttpTransportType.LongPolling;
                options.AccessTokenProvider = () => Task.FromResult<string?>(_token);
            })
            .Build();

    // ── JoinVault ─────────────────────────────────────────────────────────────

    [Fact(DisplayName = "JoinVault — le client reçoit VaultJoined avec le vaultId")]
    public async Task JoinVault_ReceivesVaultJoined()
    {
        await using var conn = CreateConnection();

        var tcs = new TaskCompletionSource<(string vaultId, int count)>();
        conn.On<string, int>("VaultJoined", (vid, count) => tcs.TrySetResult((vid, count)));

        await conn.StartAsync();
        await conn.InvokeAsync("JoinVault", _vaultId);

        var result = await tcs.Task.WaitAsync(TimeSpan.FromSeconds(5));
        result.vaultId.Should().Be(_vaultId);
    }

    // ── JoinDocument ──────────────────────────────────────────────────────────

    [Fact(DisplayName = "JoinDocument — le client reçoit InitDocument avec la liste d'opérations")]
    public async Task JoinDocument_ReceivesInitDocument()
    {
        await using var conn = CreateConnection();

        var tcs = new TaskCompletionSource<(string docId, string[] ops)>();
        conn.On<string, string[]>("InitDocument", (did, ops) => tcs.TrySetResult((did, ops)));

        await conn.StartAsync();
        await conn.InvokeAsync("JoinDocument", _vaultId, _docId);

        var result = await tcs.Task.WaitAsync(TimeSpan.FromSeconds(5));
        result.docId.Should().Be(_docId);
        result.ops.Should().NotBeNull();
    }

    [Fact(DisplayName = "JoinDocument — document inexistant est auto-créé et retourne InitDocument vide")]
    public async Task JoinDocument_NonExistentDoc_AutoCreatesAndReceivesEmptyInitDocument()
    {
        var newDocId = Guid.NewGuid().ToString();
        await using var conn = CreateConnection();

        var tcs = new TaskCompletionSource<(string docId, string[] ops)>();
        conn.On<string, string[]>("InitDocument", (did, ops) => tcs.TrySetResult((did, ops)));

        await conn.StartAsync();
        await conn.InvokeAsync("JoinDocument", _vaultId, newDocId);

        var result = await tcs.Task.WaitAsync(TimeSpan.FromSeconds(5));
        result.docId.Should().Be(newDocId);
        result.ops.Should().BeEmpty();
    }

    // ── PushOperation ─────────────────────────────────────────────────────────

    [Fact(DisplayName = "PushOperation — l'opération est relayée aux autres clients dans le document")]
    public async Task PushOperation_RelaysToOtherClientsInDocument()
    {
        await using var sender   = CreateConnection("sender-user");
        await using var receiver = CreateConnection("receiver-user");

        var tcs = new TaskCompletionSource<(string docId, string clientId, string opBase64)>();
        receiver.On<string, string, string>("ReceiveOperation", (did, cid, op) =>
            tcs.TrySetResult((did, cid, op)));

        await sender.StartAsync();
        await receiver.StartAsync();

        await sender.InvokeAsync("JoinDocument", _vaultId, _docId);
        await receiver.InvokeAsync("JoinDocument", _vaultId, _docId);

        var opPayload = Convert.ToBase64String("fake-yjs-update"u8.ToArray());
        await sender.InvokeAsync("PushOperation", _vaultId, _docId, "sender-client", opPayload);

        var result = await tcs.Task.WaitAsync(TimeSpan.FromSeconds(5));
        result.docId.Should().Be(_docId);
        result.clientId.Should().Be("sender-client");
        result.opBase64.Should().Be(opPayload);
    }

    [Fact(DisplayName = "PushOperation — l'expéditeur ne reçoit pas sa propre opération")]
    public async Task PushOperation_SenderDoesNotReceiveOwnOperation()
    {
        await using var conn = CreateConnection("solo-user");

        bool senderReceived = false;
        conn.On<string, string, string>("ReceiveOperation", (_, _, _) => senderReceived = true);

        await conn.StartAsync();
        await conn.InvokeAsync("JoinDocument", _vaultId, _docId);

        var opPayload = Convert.ToBase64String("solo-op"u8.ToArray());
        await conn.InvokeAsync("PushOperation", _vaultId, _docId, "solo-client", opPayload);

        await Task.Delay(300);
        senderReceived.Should().BeFalse();
    }

    [Fact(DisplayName = "PushOperation — base64 invalide est rejeté sans erreur pour le client")]
    public async Task PushOperation_InvalidBase64_IsRejectedGracefully()
    {
        await using var conn = CreateConnection();

        await conn.StartAsync();
        await conn.InvokeAsync("JoinDocument", _vaultId, _docId);

        // Ne doit pas lever d'exception côté client
        var act = async () => await conn.InvokeAsync(
            "PushOperation", _vaultId, _docId, "client-1", "NOT_VALID_BASE64!!!");
        await act.Should().NotThrowAsync();
    }

    [Fact(DisplayName = "PushOperation — l'opération est persistée et rejouée au prochain JoinDocument")]
    public async Task PushOperation_IsPersistedAndReplayedOnNextJoin()
    {
        await using var sender = CreateConnection("persist-sender");
        await sender.StartAsync();
        await sender.InvokeAsync("JoinDocument", _vaultId, _docId);

        var opPayload = Convert.ToBase64String("persisted-op"u8.ToArray());
        await sender.InvokeAsync("PushOperation", _vaultId, _docId, "persist-client", opPayload);
        await sender.StopAsync();

        // Nouveau client — doit recevoir l'opération dans InitDocument
        await using var newConn = CreateConnection("new-joiner");
        var tcs = new TaskCompletionSource<string[]>();
        newConn.On<string, string[]>("InitDocument", (_, ops) => tcs.TrySetResult(ops));

        await newConn.StartAsync();
        await newConn.InvokeAsync("JoinDocument", _vaultId, _docId);

        var ops = await tcs.Task.WaitAsync(TimeSpan.FromSeconds(5));
        ops.Should().Contain(opPayload);
    }

    // ── UpdateAwareness ───────────────────────────────────────────────────────

    [Fact(DisplayName = "UpdateAwareness — la mise à jour est relayée aux autres clients dans le document")]
    public async Task UpdateAwareness_RelaysToOtherClientsInDocument()
    {
        await using var sender   = CreateConnection("aware-sender");
        await using var receiver = CreateConnection("aware-receiver");

        var tcs = new TaskCompletionSource<(string docId, string payload)>();
        receiver.On<string, string>("AwarenessUpdated", (did, payload) =>
            tcs.TrySetResult((did, payload)));

        await sender.StartAsync();
        await receiver.StartAsync();

        await sender.InvokeAsync("JoinDocument", _vaultId, _docId);
        await receiver.InvokeAsync("JoinDocument", _vaultId, _docId);

        var awarenessPayload = Convert.ToBase64String("cursor-data"u8.ToArray());
        await sender.InvokeAsync("UpdateAwareness", _vaultId, _docId, awarenessPayload);

        var result = await tcs.Task.WaitAsync(TimeSpan.FromSeconds(5));
        result.docId.Should().Be(_docId);
        result.payload.Should().Be(awarenessPayload);
    }

    [Fact(DisplayName = "UpdateAwareness — l'expéditeur ne reçoit pas sa propre mise à jour")]
    public async Task UpdateAwareness_SenderDoesNotReceiveOwnUpdate()
    {
        await using var conn = CreateConnection("aware-solo");

        bool received = false;
        conn.On<string, string>("AwarenessUpdated", (_, _) => received = true);

        await conn.StartAsync();
        await conn.InvokeAsync("JoinDocument", _vaultId, _docId);

        await conn.InvokeAsync("UpdateAwareness", _vaultId, _docId,
            Convert.ToBase64String("solo-awareness"u8.ToArray()));

        await Task.Delay(300);
        received.Should().BeFalse();
    }

    // ── SnapshotDocument ──────────────────────────────────────────────────────

    [Fact(DisplayName = "SnapshotDocument — remplace l'historique, InitDocument retourne uniquement le snapshot")]
    public async Task SnapshotDocument_ReplacesHistoryWithCompactSnapshot()
    {
        // Pousser quelques opérations
        await using var writer = CreateConnection("snapshot-writer");
        await writer.StartAsync();
        await writer.InvokeAsync("JoinDocument", _vaultId, _docId);

        for (int i = 0; i < 3; i++)
        {
            var op = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes($"op-{i}"));
            await writer.InvokeAsync("PushOperation", _vaultId, _docId, "snap-client", op);
        }

        // Compacter avec un snapshot
        var snapshotPayload = Convert.ToBase64String("compact-snapshot"u8.ToArray());
        await writer.InvokeAsync("SnapshotDocument", _docId, snapshotPayload);
        await writer.StopAsync();

        // Nouveau client — doit recevoir uniquement le snapshot (1 op)
        await using var reader = CreateConnection("snapshot-reader");
        var tcs = new TaskCompletionSource<string[]>();
        reader.On<string, string[]>("InitDocument", (_, ops) => tcs.TrySetResult(ops));

        await reader.StartAsync();
        await reader.InvokeAsync("JoinDocument", _vaultId, _docId);

        var ops = await tcs.Task.WaitAsync(TimeSpan.FromSeconds(5));
        ops.Should().HaveCount(1);
        ops[0].Should().Be(snapshotPayload);
    }

    [Fact(DisplayName = "SnapshotDocument — base64 invalide est rejeté sans erreur")]
    public async Task SnapshotDocument_InvalidBase64_IsRejectedGracefully()
    {
        await using var conn = CreateConnection();
        await conn.StartAsync();

        var act = async () => await conn.InvokeAsync(
            "SnapshotDocument", _docId, "INVALID_BASE64!!!");
        await act.Should().NotThrowAsync();
    }

    // ── UpdatePresence ────────────────────────────────────────────────────────

    [Fact(DisplayName = "UpdatePresence — la position curseur est relayée aux autres clients")]
    public async Task UpdatePresence_RelaysCursorPositionToOtherClients()
    {
        await using var sender   = CreateConnection("presence-sender");
        await using var receiver = CreateConnection("presence-receiver");

        var tcs = new TaskCompletionSource<(string docId, string userId, int position)>();
        receiver.On<string, string, string, int>("PresenceUpdated",
            (did, uid, _, pos) => tcs.TrySetResult((did, uid, pos)));

        await sender.StartAsync();
        await receiver.StartAsync();

        await sender.InvokeAsync("JoinDocument", _vaultId, _docId);
        await receiver.InvokeAsync("JoinDocument", _vaultId, _docId);

        await sender.InvokeAsync("UpdatePresence", _vaultId, _docId, 42);

        var result = await tcs.Task.WaitAsync(TimeSpan.FromSeconds(5));
        result.docId.Should().Be(_docId);
        result.position.Should().Be(42);
    }

    // ── Isolation de groupe ───────────────────────────────────────────────────

    [Fact(DisplayName = "PushOperation — un client non-joint au document ne reçoit pas les opérations")]
    public async Task PushOperation_ClientNotInDocument_DoesNotReceiveOperations()
    {
        await using var sender   = CreateConnection("group-sender");
        await using var outsider = CreateConnection("group-outsider");

        bool outsiderReceived = false;
        outsider.On<string, string, string>("ReceiveOperation", (_, _, _) => outsiderReceived = true);

        await sender.StartAsync();
        await outsider.StartAsync();

        // outsider rejoint uniquement le vault, pas le document
        await sender.InvokeAsync("JoinDocument", _vaultId, _docId);

        var opPayload = Convert.ToBase64String("isolated-op"u8.ToArray());
        await sender.InvokeAsync("PushOperation", _vaultId, _docId, "isolated-client", opPayload);

        await Task.Delay(300);
        outsiderReceived.Should().BeFalse();
    }
}
