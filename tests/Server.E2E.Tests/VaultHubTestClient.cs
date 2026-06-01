// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.SignalR.Client;
using Savoire.Application.Common;

namespace Savoire.Server.E2E.Tests;

public sealed class VaultHubTestClient : IAsyncDisposable
{
    private readonly HubConnection _connection;
    private readonly object        _gate = new();

    private readonly List<(string VaultId, string[] Ops)> _initVaultEvents = new();
    private readonly List<(string VaultId, string Op)>    _vaultOpsReceived = new();

    public IReadOnlyList<(string VaultId, string[] Ops)> InitVaultEvents
    {
        get { lock (_gate) return _initVaultEvents.ToArray(); }
    }

    public IReadOnlyList<(string VaultId, string Op)> VaultOpsReceived
    {
        get { lock (_gate) return _vaultOpsReceived.ToArray(); }
    }

    public record VaultDocumentItem(string Id, string Path);

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

        _connection.On<string, string[]>("InitVault", (vaultId, ops) =>
        {
            lock (_gate) _initVaultEvents.Add((vaultId, ops));
        });

        _connection.On<string, string>("VaultOperationReceived", (vaultId, op) =>
        {
            lock (_gate) _vaultOpsReceived.Add((vaultId, op));
        });
    }

    public Task ConnectAsync() => _connection.StartAsync();

    public Task JoinVaultAsync(string vaultId)
        => _connection.InvokeAsync("JoinVault", vaultId);

    public Task<VaultDocumentItem> CreateDocumentAsync(string vaultId, string path, string? title = null)
        => _connection.InvokeAsync<VaultDocumentItem>("CreateDocument", vaultId, path, title);

    public Task RenameDocumentAsync(string documentId, string newPath)
        => _connection.InvokeAsync("RenameDocument", documentId, newPath);

    public Task DeleteDocumentAsync(string documentId)
        => _connection.InvokeAsync("DeleteDocument", documentId);

    public Task PushVaultOperationAsync(string vaultId, string opBase64)
        => _connection.InvokeAsync("PushVaultOperation", vaultId, opBase64);

    public Task WaitForInitVaultAsync(TimeSpan? timeout = null)
        => WaitForCountAsync(() => InitVaultEvents.Count, 1, timeout ?? TimeSpan.FromSeconds(3));

    public Task WaitForVaultOpsAsync(int count, TimeSpan? timeout = null)
        => WaitForCountAsync(() => VaultOpsReceived.Count, count, timeout ?? TimeSpan.FromSeconds(3));

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
}
