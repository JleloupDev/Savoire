// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Tests d'intégration — DocumentRoomHub (/hubs/room)
// Stabilise le comportement observable avant refacto éventuel.

using FluentAssertions;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.SignalR.Client;

namespace Savoire.Server.Integration.Tests.Hubs;

[Collection("Integration")]
public class DocumentRoomHubTests : IClassFixture<AppFactory>, IAsyncLifetime
{
    private readonly AppFactory _factory;
    private string _token  = null!;
    private string _userId = null!;
    private string _docId  = null!;

    public DocumentRoomHubTests(AppFactory factory) => _factory = factory;

    public async Task InitializeAsync()
    {
        var uid = Guid.NewGuid().ToString("N")[..8];
        (_token, _userId) = await _factory.CreateUserAndGetTokenAsync(
            $"room-hub-{uid}@test.com", displayName: "Room Hub User");

        // docId unique par instance pour éviter toute interférence avec le cache statique
        _docId = Guid.NewGuid().ToString();
    }

    public Task DisposeAsync() => Task.CompletedTask;

    private HubConnection CreateConnection() =>
        new HubConnectionBuilder()
            .WithUrl("http://localhost/hubs/room", options =>
            {
                options.HttpMessageHandlerFactory = _ => _factory.Server.CreateHandler();
                options.Transports = HttpTransportType.LongPolling;
                options.AccessTokenProvider = () => Task.FromResult<string?>(_token);
            })
            .Build();

    // ── Auth ──────────────────────────────────────────────────────────────────

    [Fact(DisplayName = "DocumentRoomHub — connexion sans token est refusée (401)")]
    public async Task JoinRoom_WithoutToken_ConnectionFails()
    {
        await using var conn = new HubConnectionBuilder()
            .WithUrl("http://localhost/hubs/room", options =>
            {
                options.HttpMessageHandlerFactory = _ => _factory.Server.CreateHandler();
                options.Transports = HttpTransportType.LongPolling;
            })
            .Build();

        var act = () => conn.StartAsync();
        await act.Should().ThrowAsync<Exception>();
    }

    // ── JoinRoom ──────────────────────────────────────────────────────────────

    [Fact(DisplayName = "JoinRoom — le client reçoit RoomJoined avec snapshot null si aucun snapshot en cache")]
    public async Task JoinRoom_ReceivesRoomJoined_WithNullSnapshot_WhenNoCache()
    {
        var freshDocId = Guid.NewGuid().ToString();
        await using var conn = CreateConnection();

        var tcs = new TaskCompletionSource<(string docId, string? snapshot)>();
        conn.On<string, string?>("RoomJoined", (did, snap) => tcs.TrySetResult((did, snap)));

        await conn.StartAsync();
        await conn.InvokeAsync("JoinRoom", "vault-id", freshDocId);

        var result = await tcs.Task.WaitAsync(TimeSpan.FromSeconds(5));
        result.docId.Should().Be(freshDocId);
        result.snapshot.Should().BeNull();
    }

    [Fact(DisplayName = "JoinRoom — le client reçoit le dernier snapshot mis en cache")]
    public async Task JoinRoom_ReceivesRoomJoined_WithCachedSnapshot_AfterPush()
    {
        var snapshotJson = """{"content":"# Hello cached"}""";

        await using var sender = CreateConnection();
        await sender.StartAsync();
        await sender.InvokeAsync("JoinRoom", "vault-id", _docId);
        await sender.InvokeAsync("PushSnapshot", "vault-id", _docId, snapshotJson);
        await sender.StopAsync();

        await using var reader = CreateConnection();
        var tcs = new TaskCompletionSource<(string docId, string? snapshot)>();
        reader.On<string, string?>("RoomJoined", (did, snap) => tcs.TrySetResult((did, snap)));

        await reader.StartAsync();
        await reader.InvokeAsync("JoinRoom", "vault-id", _docId);

        var result = await tcs.Task.WaitAsync(TimeSpan.FromSeconds(5));
        result.docId.Should().Be(_docId);
        result.snapshot.Should().Be(snapshotJson);
    }

    // ── PushSnapshot ──────────────────────────────────────────────────────────

    [Fact(DisplayName = "PushSnapshot — le snapshot est relayé aux autres clients de la room")]
    public async Task PushSnapshot_RelaysSnapshotToOtherClientsInRoom()
    {
        await using var sender   = CreateConnection();
        await using var receiver = CreateConnection();

        var tcs = new TaskCompletionSource<(string docId, string userId, string snap)>();
        receiver.On<string, string, string>("SnapshotReceived",
            (did, uid, snap) => tcs.TrySetResult((did, uid, snap)));

        await sender.StartAsync();
        await receiver.StartAsync();

        await sender.InvokeAsync("JoinRoom", "vault-id", _docId);
        await receiver.InvokeAsync("JoinRoom", "vault-id", _docId);

        var payload = """{"content":"# Collaboration"}""";
        await sender.InvokeAsync("PushSnapshot", "vault-id", _docId, payload);

        var result = await tcs.Task.WaitAsync(TimeSpan.FromSeconds(5));
        result.docId.Should().Be(_docId);
        result.userId.Should().Be(_userId);
        result.snap.Should().Be(payload);
    }

    [Fact(DisplayName = "PushSnapshot — l'expéditeur ne reçoit pas son propre snapshot")]
    public async Task PushSnapshot_SenderDoesNotReceiveOwnSnapshot()
    {
        await using var conn = CreateConnection();

        bool received = false;
        conn.On<string, string, string>("SnapshotReceived", (_, _, _) => received = true);

        await conn.StartAsync();
        await conn.InvokeAsync("JoinRoom", "vault-id", _docId);
        await conn.InvokeAsync("PushSnapshot", "vault-id", _docId, """{"content":"solo"}""");

        await Task.Delay(300);
        received.Should().BeFalse();
    }

    [Fact(DisplayName = "PushSnapshot — snapshot mis en cache et retourné au prochain JoinRoom")]
    public async Task PushSnapshot_IsCachedAndReturnedOnNextJoin()
    {
        var cacheDocId   = Guid.NewGuid().ToString();
        var snapshotJson = """{"content":"# Cached snapshot"}""";

        await using var writer = CreateConnection();
        await writer.StartAsync();
        await writer.InvokeAsync("JoinRoom", "vault-id", cacheDocId);
        await writer.InvokeAsync("PushSnapshot", "vault-id", cacheDocId, snapshotJson);
        await writer.StopAsync();

        await using var reader = CreateConnection();
        var tcs = new TaskCompletionSource<string?>();
        reader.On<string, string?>("RoomJoined", (_, snap) => tcs.TrySetResult(snap));

        await reader.StartAsync();
        await reader.InvokeAsync("JoinRoom", "vault-id", cacheDocId);

        var snap = await tcs.Task.WaitAsync(TimeSpan.FromSeconds(5));
        snap.Should().Be(snapshotJson);
    }

    // ── UpdatePresence ────────────────────────────────────────────────────────

    [Fact(DisplayName = "UpdatePresence — la présence est relayée aux autres clients de la room")]
    public async Task UpdatePresence_RelaysPresenceToOtherClientsInRoom()
    {
        await using var sender   = CreateConnection();
        await using var receiver = CreateConnection();

        var tcs = new TaskCompletionSource<(string docId, string userId, string presence)>();
        receiver.On<string, string, string>("PresenceUpdated",
            (did, uid, pres) => tcs.TrySetResult((did, uid, pres)));

        await sender.StartAsync();
        await receiver.StartAsync();

        await sender.InvokeAsync("JoinRoom", "vault-id", _docId);
        await receiver.InvokeAsync("JoinRoom", "vault-id", _docId);

        var presenceJson = """{"cursor":42,"user":"Alice"}""";
        await sender.InvokeAsync("UpdatePresence", "vault-id", _docId, presenceJson);

        var result = await tcs.Task.WaitAsync(TimeSpan.FromSeconds(5));
        result.docId.Should().Be(_docId);
        result.userId.Should().Be(_userId);
        result.presence.Should().Be(presenceJson);
    }

    [Fact(DisplayName = "UpdatePresence — l'expéditeur ne reçoit pas sa propre présence")]
    public async Task UpdatePresence_SenderDoesNotReceiveOwnPresence()
    {
        await using var conn = CreateConnection();

        bool received = false;
        conn.On<string, string, string>("PresenceUpdated", (_, _, _) => received = true);

        await conn.StartAsync();
        await conn.InvokeAsync("JoinRoom", "vault-id", _docId);
        await conn.InvokeAsync("UpdatePresence", "vault-id", _docId, """{"cursor":0}""");

        await Task.Delay(300);
        received.Should().BeFalse();
    }

    // ── Isolation de room ─────────────────────────────────────────────────────

    [Fact(DisplayName = "PushSnapshot — un client non-joint à la room ne reçoit pas le snapshot")]
    public async Task PushSnapshot_ClientNotInRoom_DoesNotReceiveSnapshot()
    {
        var otherDocId = Guid.NewGuid().ToString();

        await using var sender   = CreateConnection();
        await using var outsider = CreateConnection();

        bool outsiderReceived = false;
        outsider.On<string, string, string>("SnapshotReceived", (_, _, _) => outsiderReceived = true);

        await sender.StartAsync();
        await outsider.StartAsync();

        await sender.InvokeAsync("JoinRoom", "vault-id", _docId);
        await outsider.InvokeAsync("JoinRoom", "vault-id", otherDocId);

        await sender.InvokeAsync("PushSnapshot", "vault-id", _docId, """{"content":"isolated"}""");

        await Task.Delay(300);
        outsiderReceived.Should().BeFalse();
    }
}
