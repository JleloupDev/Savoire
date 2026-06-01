// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
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

    // ── JoinVault / InitVault ─────────────────────────────────────────────────

    [Fact]
    public async Task JoinVault_ReceivesInitVault()
    {
        await using HubConnection conn = CreateConnection();

        var tcs = new TaskCompletionSource<(string vaultId, string[] ops)>();
        conn.On<string, string[]>("InitVault", (vId, ops) => tcs.TrySetResult((vId, ops)));

        await conn.StartAsync();
        await conn.InvokeAsync("JoinVault", _vaultId);

        var (vaultId, ops) = await tcs.Task.WaitAsync(TimeSpan.FromSeconds(5));
        vaultId.Should().Be(_vaultId);
        ops.Should().NotBeNull();
    }

    [Fact]
    public async Task JoinVault_FreshVault_InitVaultHasNoOps()
    {
        await using HubConnection conn = CreateConnection();

        var tcs = new TaskCompletionSource<string[]>();
        conn.On<string, string[]>("InitVault", (_, ops) => tcs.TrySetResult(ops));

        await conn.StartAsync();
        await conn.InvokeAsync("JoinVault", _vaultId);

        var ops = await tcs.Task.WaitAsync(TimeSpan.FromSeconds(5));
        ops.Should().BeEmpty();
    }

    // ── PushVaultOperation / VaultOperationReceived ───────────────────────────

    [Fact]
    public async Task PushVaultOperation_RelaysToOtherClientsInVault()
    {
        await using HubConnection sender   = CreateConnection();
        await using HubConnection receiver = CreateConnection();

        var tcs = new TaskCompletionSource<(string vaultId, string op)>();
        receiver.On<string, string>("VaultOperationReceived", (vId, op) => tcs.TrySetResult((vId, op)));

        await sender.StartAsync();
        await receiver.StartAsync();
        await sender.InvokeAsync("JoinVault", _vaultId);
        await receiver.InvokeAsync("JoinVault", _vaultId);

        var fakeOp = Convert.ToBase64String([1, 2, 3, 4]);
        await sender.InvokeAsync("PushVaultOperation", _vaultId, fakeOp);

        var (vaultId, received) = await tcs.Task.WaitAsync(TimeSpan.FromSeconds(5));
        vaultId.Should().Be(_vaultId);
        received.Should().Be(fakeOp);
    }

    [Fact]
    public async Task PushVaultOperation_NotRelayedBackToSender()
    {
        await using HubConnection conn = CreateConnection();

        bool senderReceived = false;
        conn.On<string, string>("VaultOperationReceived", (_, _) => senderReceived = true);

        await conn.StartAsync();
        await conn.InvokeAsync("JoinVault", _vaultId);
        await conn.InvokeAsync("PushVaultOperation", _vaultId, Convert.ToBase64String([9, 8, 7]));

        await Task.Delay(200);
        senderReceived.Should().BeFalse();
    }

    [Fact]
    public async Task PushVaultOperation_StoredAndReturnedOnNextJoin()
    {
        await using HubConnection writer = CreateConnection();
        await writer.StartAsync();
        await writer.InvokeAsync("JoinVault", _vaultId);

        var fakeOp = Convert.ToBase64String([0xAB, 0xCD]);
        await writer.InvokeAsync("PushVaultOperation", _vaultId, fakeOp);
        await writer.StopAsync();

        // New connection joins: should receive the stored op via InitVault
        await using HubConnection reader = CreateConnection();
        var tcs = new TaskCompletionSource<string[]>();
        reader.On<string, string[]>("InitVault", (_, ops) => tcs.TrySetResult(ops));

        await reader.StartAsync();
        await reader.InvokeAsync("JoinVault", _vaultId);

        var ops = await tcs.Task.WaitAsync(TimeSpan.FromSeconds(5));
        ops.Should().Contain(fakeOp);
    }

    // ── CreateDocument ────────────────────────────────────────────────────────

    [Fact]
    public async Task CreateDocument_ReturnsVaultDocumentItem()
    {
        await using HubConnection conn = CreateConnection();
        await conn.StartAsync();
        await conn.InvokeAsync("JoinVault", _vaultId);

        var path = $"doc-{Guid.NewGuid():N}.md";
        var item = await conn.InvokeAsync<VaultDocumentItem>("CreateDocument", _vaultId, path, null);

        item.Should().NotBeNull();
        item.Path.Should().Be(path);
        item.Id.Should().NotBeNullOrEmpty();
    }

    [Fact]
    public async Task CreateDocument_DuplicatePath_ThrowsHubException409()
    {
        await using HubConnection conn = CreateConnection();
        await conn.StartAsync();
        await conn.InvokeAsync("JoinVault", _vaultId);

        var path = $"dup-{Guid.NewGuid():N}.md";
        await conn.InvokeAsync<VaultDocumentItem>("CreateDocument", _vaultId, path, null);

        var act = () => conn.InvokeAsync<VaultDocumentItem>("CreateDocument", _vaultId, path, null);
        await act.Should().ThrowAsync<Exception>().WithMessage("*409*");
    }

    // ── Auth ──────────────────────────────────────────────────────────────────

    [Fact(DisplayName = "VaultHub — connexion sans token est refusee (401)")]
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

    // ── PushIndexOp ───────────────────────────────────────────────────────────

    [Fact(DisplayName = "PushIndexOp — retourne un numero de sequence positif")]
    public async Task PushIndexOp_ReturnsSequenceNumber()
    {
        await using HubConnection conn = CreateConnection();
        await conn.StartAsync();
        await conn.InvokeAsync("JoinVault", _vaultId);

        var doc = await conn.InvokeAsync<VaultDocumentItem>("CreateDocument", _vaultId, "index-seq.md", null);
        var dto = new PushIndexOpDto(_vaultId, doc.Id, doc.Path, "# Hello index");
        long seq = await conn.InvokeAsync<long>("PushIndexOp", dto);

        seq.Should().BePositive();
    }
}
