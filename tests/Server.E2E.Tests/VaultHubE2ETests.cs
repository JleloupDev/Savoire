// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Tests E2E - VaultHub (vault CRDT relay)
//
// Scenarios couverts :
//   VH-02  JoinVault vault vide → InitVault avec ops vides
//   VH-05  PushVaultOperation → relaie VaultOperationReceived aux autres
//   VH-06  Op stockee → retournee dans InitVault au prochain join
//   VH-09  VaultHub sans token → refus 401

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
    private string     _userIdA = null!;
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

        (string tokenB, string _) = await _server.CreateUserAndGetTokenAsync(
            $"vh-b-{uid}@test.com", displayName: "VH User B");
        _tokenB = tokenB;
    }

    public async Task DisposeAsync()
    {
        _clientA.Dispose();
        await _server.DisposeAsync();
    }

    private async Task<VaultSummaryDto> CreateVaultAsync(string userId, string name)
    {
        var resp = await _clientA.PostAsJsonAsync($"/api/v1/users/{userId}/vaults", new { name });
        resp.EnsureSuccessStatusCode();
        return (await resp.Content.ReadFromJsonAsync<VaultSummaryDto>())!;
    }

    private VaultHubTestClient HubA(HttpTransportType t = HttpTransportType.ServerSentEvents)
        => new(_server, _tokenA, t);

    private VaultHubTestClient HubB(HttpTransportType t = HttpTransportType.ServerSentEvents)
        => new(_server, _tokenB, t);

    // ── VH-02 : JoinVault vault vide → InitVault vide ─────────────────────────

    [Fact]
    public async Task VH02_JoinVault_Empty_ReceivesEmptyInitVault()
    {
        var vault = await CreateVaultAsync(_userIdA, "Vault Vide");

        await using var hub = HubA();
        await hub.ConnectAsync();
        await hub.JoinVaultAsync(vault.Id);
        await hub.WaitForInitVaultAsync();

        hub.InitVaultEvents[0].Ops.Should().BeEmpty();
    }

    // ── VH-05 : PushVaultOperation → VaultOperationReceived aux autres ────────

    [Fact]
    public async Task VH05_PushVaultOperation_RelaysToOtherClients()
    {
        var vault = await CreateVaultAsync(_userIdA, "Vault Relay");
        await _clientA.PostAsJsonAsync(
            $"/api/v1/vaults/{vault.Id}/members", new { userId = "user-b", role = "editor" });

        await using var hubA = HubA();
        await using var hubB = HubB();
        await hubA.ConnectAsync();
        await hubB.ConnectAsync();
        await hubA.JoinVaultAsync(vault.Id);
        await hubB.JoinVaultAsync(vault.Id);
        await hubA.WaitForInitVaultAsync();
        await hubB.WaitForInitVaultAsync();

        var fakeOp = Convert.ToBase64String([0x01, 0x02, 0x03]);
        await hubA.PushVaultOperationAsync(vault.Id, fakeOp);

        await hubB.WaitForVaultOpsAsync(1);
        hubB.VaultOpsReceived[0].Op.Should().Be(fakeOp);
        hubA.VaultOpsReceived.Should().BeEmpty(); // sender ne recoit pas son propre op
    }

    // ── VH-06 : Op stockee → retournee dans InitVault au prochain join ────────

    [Fact]
    public async Task VH06_StoredOp_ReturnedOnNextJoin()
    {
        var vault = await CreateVaultAsync(_userIdA, "Vault Persist");

        await using var writer = HubA();
        await writer.ConnectAsync();
        await writer.JoinVaultAsync(vault.Id);
        await writer.WaitForInitVaultAsync();

        var fakeOp = Convert.ToBase64String([0xAB, 0xCD, 0xEF]);
        await writer.PushVaultOperationAsync(vault.Id, fakeOp);

        await using var reader = HubA();
        await reader.ConnectAsync();
        await reader.JoinVaultAsync(vault.Id);
        await reader.WaitForInitVaultAsync();

        reader.InitVaultEvents[0].Ops.Should().Contain(fakeOp);
    }

    // ── VH-09 : Sans token → 401 ─────────────────────────────────────────────

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

        await Assert.ThrowsAnyAsync<Exception>(() => hubNoAuth.StartAsync());
    }
}
