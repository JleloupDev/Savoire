// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// VaultHubTestClient — client SignalR de test pour /hubs/vault.
// Contrairement à SignalRTestClient (SyncHub), VaultHub est [Authorize] → le JWT
// est passé en query string ?access_token=... (géré par JwtBearerEvents.OnMessageReceived).
//
// Événements écoutés : VaultSnapshot, DocumentCreated, DocumentRenamed, DocumentDeleted.

using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.SignalR.Client;
using Savoire.Application.Common;

namespace Savoire.Server.E2E.Tests;

public sealed class VaultHubTestClient : IAsyncDisposable
{
    private readonly HubConnection _connection;
    private readonly object        _gate = new();

    // ── Captured events ──────────────────────────────────────────────────────

    private readonly List<VaultSnapshotItem>    _snapshots       = new();
    private readonly List<DocumentCreatedData>  _createdEvents   = new();
    private readonly List<DocumentRenamedData>  _renamedEvents   = new();
    private readonly List<DocumentDeletedData>  _deletedEvents   = new();

    public IReadOnlyList<VaultSnapshotItem>    Snapshots       { get { lock (_gate) return _snapshots.ToArray(); } }
    public IReadOnlyList<DocumentCreatedData>  CreatedEvents   { get { lock (_gate) return _createdEvents.ToArray(); } }
    public IReadOnlyList<DocumentRenamedData>  RenamedEvents   { get { lock (_gate) return _renamedEvents.ToArray(); } }
    public IReadOnlyList<DocumentDeletedData>  DeletedEvents   { get { lock (_gate) return _deletedEvents.ToArray(); } }

    // ── DTOs reçus depuis le serveur (mirror de VaultHubDtos.cs) ─────────────

    public record VaultSnapshotItem(string Id, string Path, string? Title, string? UpdatedAt);
    public record DocumentCreatedData(string Id, string VaultId, string Path, string? Title);
    public record DocumentRenamedData(string Id, string OldPath, string NewPath);
    public record DocumentDeletedData(string Id, string Path);

    public VaultHubTestClient(
        WebApplicationFactory<Program> factory,
        string jwtToken,
        HttpTransportType transport = HttpTransportType.ServerSentEvents)
    {
        _connection = new HubConnectionBuilder()
            .WithUrl($"http://localhost/hubs/vault?access_token={Uri.EscapeDataString(jwtToken)}",
                options =>
                {
                    options.HttpMessageHandlerFactory = _ => factory.Server.CreateHandler();
                    options.Transports = transport;
                })
            .Build();

        _connection.On<IEnumerable<object>>("VaultSnapshot", raw =>
        {
            // SignalR désérialise les listes en JsonElement[] — on utilise les DTOs Application
            var items = DeserializeItems(raw);
            lock (_gate) _snapshots.AddRange(items);
        });

        _connection.On<object>("DocumentCreated", raw =>
        {
            var data = Deserialize<DocumentCreatedData>(raw);
            lock (_gate) _createdEvents.Add(data);
        });

        _connection.On<object>("DocumentRenamed", raw =>
        {
            var data = Deserialize<DocumentRenamedData>(raw);
            lock (_gate) _renamedEvents.Add(data);
        });

        _connection.On<object>("DocumentDeleted", raw =>
        {
            var data = Deserialize<DocumentDeletedData>(raw);
            lock (_gate) _deletedEvents.Add(data);
        });
    }

    // ── Hub methods ───────────────────────────────────────────────────────────

    public Task ConnectAsync() => _connection.StartAsync();

    public Task JoinVaultAsync(string vaultId)
        => _connection.InvokeAsync("JoinVault", vaultId);

    public Task<VaultSnapshotItem> CreateDocumentAsync(string vaultId, string path, string? title = null)
        => _connection.InvokeAsync<VaultSnapshotItem>("CreateDocument", vaultId, path, title);

    public Task RenameDocumentAsync(string documentId, string newPath)
        => _connection.InvokeAsync("RenameDocument", documentId, newPath);

    public Task DeleteDocumentAsync(string documentId)
        => _connection.InvokeAsync("DeleteDocument", documentId);

    // ── Wait helpers ──────────────────────────────────────────────────────────

    public Task WaitForSnapshotAsync(TimeSpan? timeout = null)
        => WaitForCountAsync(() => Snapshots.Count, 1, timeout ?? TimeSpan.FromSeconds(3));

    public Task WaitForCreatedAsync(int count, TimeSpan? timeout = null)
        => WaitForCountAsync(() => CreatedEvents.Count, count, timeout ?? TimeSpan.FromSeconds(3));

    public Task WaitForRenamedAsync(int count, TimeSpan? timeout = null)
        => WaitForCountAsync(() => RenamedEvents.Count, count, timeout ?? TimeSpan.FromSeconds(3));

    public Task WaitForDeletedAsync(int count, TimeSpan? timeout = null)
        => WaitForCountAsync(() => DeletedEvents.Count, count, timeout ?? TimeSpan.FromSeconds(3));

    private static async Task WaitForCountAsync(Func<int> counter, int expected, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            if (counter() >= expected) return;
            await Task.Delay(15);
        }
    }

    public async ValueTask DisposeAsync() => await _connection.DisposeAsync();

    // ── Deserialization helpers ───────────────────────────────────────────────

    private static T Deserialize<T>(object raw)
    {
        var json = System.Text.Json.JsonSerializer.Serialize(raw);
        return System.Text.Json.JsonSerializer.Deserialize<T>(json,
            new System.Text.Json.JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
    }

    private static IEnumerable<VaultSnapshotItem> DeserializeItems(IEnumerable<object> raw)
    {
        var json = System.Text.Json.JsonSerializer.Serialize(raw);
        return System.Text.Json.JsonSerializer.Deserialize<List<VaultSnapshotItem>>(json,
            new System.Text.Json.JsonSerializerOptions { PropertyNameCaseInsensitive = true })
            ?? [];
    }
}
