// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Helper SignalR pour les tests E2E.
// Crée un HubConnection pointant sur l'instance WebApplicationFactory en mémoire.
// 
// IMPORTANT: Supporte ServerSentEvents et LongPolling (pas WebSockets avec WebApplicationFactory).
// Utilisez le paramètre 'transport' pour spécifier le mode de transport à tester.
// Par défaut: ServerSentEvents.

using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.SignalR.Client;

namespace Savoire.Server.E2E.Tests;

public sealed class SignalRTestClient : IAsyncDisposable
{
    private readonly HubConnection _connection;
    private readonly object _gate = new();
    private readonly List<(string DocId, string ClientId, byte[] Op)> _receivedOps = new();
    private readonly List<(string DocId, byte[][] Ops)> _initEvents = new();

    public IReadOnlyList<(string DocId, string ClientId, byte[] Op)> ReceivedOps
    {
        get
        {
            lock (_gate)
            {
                return _receivedOps.ToArray();
            }
        }
    }

    public IReadOnlyList<(string DocId, byte[][] Ops)> InitEvents
    {
        get
        {
            lock (_gate)
            {
                return _initEvents.ToArray();
            }
        }
    }

    public SignalRTestClient(
        WebApplicationFactory<Program> factory, 
        string userId,
        string? accessToken = null,
        Microsoft.AspNetCore.Http.Connections.HttpTransportType? transport = null)
    {
        _connection = new HubConnectionBuilder()
            .WithUrl($"http://localhost/hubs/sync?userId={Uri.EscapeDataString(userId)}",
                options =>
                {
                    options.HttpMessageHandlerFactory = _ => factory.Server.CreateHandler();
                    // Forcer l'utilisation de ServerSentEvents ou LongPolling pour éviter les échecs WebSocket
                    // dans les tests avec WebApplicationFactory (WebSockets ne fonctionne pas en in-memory)
                    options.Transports = transport ?? Microsoft.AspNetCore.Http.Connections.HttpTransportType.ServerSentEvents;
                    options.AccessTokenProvider = () => Task.FromResult(accessToken);

                    // LongPolling configuré via Transports (pas d'option PollTimeout disponible ici).
                })
            .Build();

        _connection.On<string, string[]>("InitDocument", (docId, opsBase64) =>
        {
            byte[][] ops = opsBase64.Select(Convert.FromBase64String).ToArray();
            lock (_gate)
            {
                _initEvents.Add((docId, ops));
            }
        });

        _connection.On<string, string, string>("ReceiveOperation", (docId, clientId, opBase64) =>
        {
            byte[] op = Convert.FromBase64String(opBase64);
            lock (_gate)
            {
                _receivedOps.Add((docId, clientId, op));
            }
        });
    }

    public async Task ConnectAsync()
        => await _connection.StartAsync();

    public async Task JoinDocumentAsync(string vaultId, string docId)
        => await _connection.InvokeAsync("JoinDocument", vaultId, docId);

    public async Task PushOperationAsync(string vaultId, string docId, string clientId, byte[] op)
        => await _connection.InvokeAsync("PushOperation", vaultId, docId, clientId, Convert.ToBase64String(op));

    public async Task WaitForReceiveAsync(int expectedCount, TimeSpan? timeout = null)
    {
        var deadline = DateTime.UtcNow + (timeout ?? TimeSpan.FromSeconds(5));
        while (DateTime.UtcNow < deadline)
        {
            lock (_gate)
            {
                if (_receivedOps.Count >= expectedCount)
                    return;
            }

            await Task.Delay(10); // Réduire le délai de polling pour une détection plus rapide
        }
    }

    public async ValueTask DisposeAsync()
        => await _connection.DisposeAsync();
}
