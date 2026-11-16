// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Limites d'usage (revue du 14/11/2026, E4) : un compte ne remplit pas le
// disque. Le quota est celui du proprietaire du vault, quel que soit le
// membre qui ecrit ; liberer de la place rouvre l'ecriture.

using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;
using FluentAssertions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Savoire.Application.Common;

namespace Savoire.Server.Integration.Tests.Vaults;

[Collection("Integration")]
public class QuotaTests : IClassFixture<AppFactory>
{
    private readonly AppFactory _factory;
    public QuotaTests(AppFactory factory) => _factory = factory;

    private static string Uid() => Guid.NewGuid().ToString("N")[..8];

    /// <summary>Le serveur avec des limites basses (le reste comme d'habitude).</summary>
    private WebApplicationFactory<Program> Limited(params (string Key, string Value)[] settings) =>
        _factory.WithWebHostBuilder(b =>
        {
            b.UseSetting("Limits:MinFreeDiskBytes", "0");
            foreach ((string key, string value) in settings) b.UseSetting(key, value);
        });

    private static HttpClient Authed(WebApplicationFactory<Program> app, string token)
    {
        HttpClient c = app.CreateClient();
        c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return c;
    }

    private static HubConnection Connect(WebApplicationFactory<Program> app, string hub, string token) =>
        new HubConnectionBuilder()
            .WithUrl($"http://localhost/hubs/{hub}", options =>
            {
                options.HttpMessageHandlerFactory = _ => app.Server.CreateHandler();
                options.Transports = HttpTransportType.LongPolling;
                options.AccessTokenProvider = () => Task.FromResult<string?>(token);
            })
            .Build();

    private static async Task<string> VaultAsync(HttpClient client, string userId, string name = "Vault")
    {
        var resp = await client.PostAsJsonAsync($"/api/v1/users/{userId}/vaults", new { name });
        resp.EnsureSuccessStatusCode();
        return (await resp.Content.ReadFromJsonAsync<VaultSummaryDto>())!.Id;
    }

    private static Task<HttpResponseMessage> UploadAsync(HttpClient client, string vaultId, int bytes)
    {
        var form = new MultipartFormDataContent { { new ByteArrayContent(new byte[bytes]), "file", "f.bin" } };
        return client.PostAsync($"/api/v1/vaults/{vaultId}/attachments", form);
    }

    [Fact(DisplayName = "Fichiers : au-dela du quota du proprietaire, refus (413) ; liberer de la place rouvre l'envoi")]
    public async Task Upload_StopsAtQuota()
    {
        using var app = Limited(("Limits:AccountBytes", "100000"));
        (string token, string userId) = await _factory.CreateUserAndGetTokenAsync($"quota-up-{Uid()}@test.com", displayName: "Q");
        HttpClient client = Authed(app, token);
        string vaultId = await VaultAsync(client, userId);

        var first = await UploadAsync(client, vaultId, 60_000);
        first.StatusCode.Should().Be(HttpStatusCode.OK);
        string path = (await first.Content.ReadFromJsonAsync<JsonObject>())!["path"]!.GetValue<string>();

        var refused = await UploadAsync(client, vaultId, 60_000);
        refused.StatusCode.Should().Be(HttpStatusCode.RequestEntityTooLarge);
        (await refused.Content.ReadAsStringAsync()).Should().Contain("quota");

        // Un autre vault du meme compte : meme quota.
        string other = await VaultAsync(client, userId, "Autre");
        (await UploadAsync(client, other, 60_000)).StatusCode.Should().Be(HttpStatusCode.RequestEntityTooLarge);

        (await client.DeleteAsync($"/api/v1/vaults/{vaultId}/attachments/{path}")).StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await UploadAsync(client, vaultId, 60_000)).StatusCode.Should().Be(HttpStatusCode.OK);

        JsonObject usage = (await client.GetFromJsonAsync<JsonObject>("/api/v1/auth/me/usage"))!;
        usage["quotaBytes"]!.GetValue<long>().Should().Be(100_000);
        usage["usedBytes"]!.GetValue<long>().Should().BeInRange(60_000, 100_000);
        usage["vaults"]!.AsArray().Should().HaveCount(2);
    }

    [Fact(DisplayName = "Le quota est celui du proprietaire : un membre qui ecrit le consomme")]
    public async Task Member_ConsumesOwnerQuota()
    {
        using var app = Limited(("Limits:AccountBytes", "100000"));
        string uid = Uid();
        (string ownerToken, string ownerId) = await _factory.CreateUserAndGetTokenAsync($"quota-owner-{uid}@test.com", displayName: "Owner");
        (string memberToken, string memberId) = await _factory.CreateUserAndGetTokenAsync($"quota-member-{uid}@test.com", displayName: "Member");
        HttpClient owner = Authed(app, ownerToken);
        string vaultId = await VaultAsync(owner, ownerId);
        (await owner.PostAsJsonAsync($"/api/v1/vaults/{vaultId}/members", new { userId = memberId, role = "editor" })).EnsureSuccessStatusCode();
        (await UploadAsync(owner, vaultId, 70_000)).StatusCode.Should().Be(HttpStatusCode.OK);

        // Le membre a son propre quota intact, mais ecrit chez le proprietaire.
        (await UploadAsync(Authed(app, memberToken), vaultId, 40_000)).StatusCode.Should().Be(HttpStatusCode.RequestEntityTooLarge);
        string memberVault = await VaultAsync(Authed(app, memberToken), memberId);
        (await UploadAsync(Authed(app, memberToken), memberVault, 40_000)).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact(DisplayName = "Notes : une ecriture au-dela du quota est refusee par le hub (quota-exceeded)")]
    public async Task HubWrite_StopsAtQuota()
    {
        using var app = Limited(("Limits:AccountBytes", "50000"));
        (string token, string userId) = await _factory.CreateUserAndGetTokenAsync($"quota-hub-{Uid()}@test.com", displayName: "Q");
        HttpClient client = Authed(app, token);
        string vaultId = await VaultAsync(client, userId);
        string docId = Guid.NewGuid().ToString();

        await using var vault = Connect(app, "vault", token);
        await using var sync = Connect(app, "sync", token);
        await vault.StartAsync(); await sync.StartAsync();
        (await vault.InvokeAsync<string[]>("RegisterDocuments", vaultId, new[] { docId })).Should().BeEmpty();
        await sync.InvokeAsync("JoinDocument", vaultId, docId);
        string op = Convert.ToBase64String(new byte[30_000]);
        await sync.InvokeAsync("PushOperation", vaultId, docId, "c", op);

        var again = () => sync.InvokeAsync("PushOperation", vaultId, docId, "c", op);
        (await again.Should().ThrowAsync<HubException>()).Which.Message.Should().Contain("quota-exceeded");
        var dir = () => vault.InvokeAsync("PushVaultOperation", vaultId, op);
        await dir.Should().ThrowAsync<HubException>();
    }

    [Fact(DisplayName = "Un compte a un nombre de vaults borne")]
    public async Task VaultCount_IsBounded()
    {
        using var app = Limited(("Limits:VaultsPerAccount", "2"));
        (string token, string userId) = await _factory.CreateUserAndGetTokenAsync($"quota-count-{Uid()}@test.com", displayName: "Q");
        HttpClient client = Authed(app, token);
        await VaultAsync(client, userId, "Un");
        string two = await VaultAsync(client, userId, "Deux");

        var third = await client.PostAsJsonAsync($"/api/v1/users/{userId}/vaults", new { name = "Trois" });
        third.StatusCode.Should().Be(HttpStatusCode.RequestEntityTooLarge);

        (await client.DeleteAsync($"/api/v1/vaults/{two}")).StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await client.PostAsJsonAsync($"/api/v1/users/{userId}/vaults", new { name = "Trois" })).StatusCode.Should().Be(HttpStatusCode.Created);
    }

    [Fact(DisplayName = "Disque presque plein : les gros envois sont refuses pour tous (507)")]
    public async Task DiskAlmostFull_RefusesBigUploads()
    {
        // Place libre exigee : plus que n'importe quel disque.
        using var app = _factory.WithWebHostBuilder(b => b.UseSetting("Limits:MinFreeDiskBytes", long.MaxValue.ToString()));
        (string token, string userId) = await _factory.CreateUserAndGetTokenAsync($"quota-disk-{Uid()}@test.com", displayName: "Q");
        HttpClient client = Authed(app, token);
        string vaultId = await VaultAsync(client, userId);

        (await UploadAsync(client, vaultId, 300_000)).StatusCode.Should().Be(HttpStatusCode.InsufficientStorage);
        // Un petit envoi (une frappe) passe encore.
        (await UploadAsync(client, vaultId, 1_000)).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact(DisplayName = "Hubs : un compte qui inonde le serveur est arrete (rate-limited)")]
    public async Task HubCalls_AreRateLimited()
    {
        using var app = Limited(("Limits:HubCallsPerMinute", "20"));
        (string token, string userId) = await _factory.CreateUserAndGetTokenAsync($"quota-flood-{Uid()}@test.com", displayName: "Q");
        string vaultId = await VaultAsync(Authed(app, token), userId);
        await using var vault = Connect(app, "vault", token);
        await vault.StartAsync();

        var errors = new List<string>();
        for (int i = 0; i < 40; i++)
        {
            try { await vault.InvokeAsync("CheckVaultAccess", vaultId); }
            catch (HubException e) { errors.Add(e.Message); }
        }
        errors.Should().NotBeEmpty().And.OnlyContain(m => m.Contains("rate-limited"));
        errors.Count.Should().BeLessThanOrEqualTo(25);
    }

    [Fact(DisplayName = "Sans compte : ouvrir des liens de partage a la chaine est limite par adresse (429)")]
    public async Task AnonymousRoutes_AreRateLimited()
    {
        using var app = Limited(("Limits:AnonymousPerMinute", "10"));
        HttpClient anonymous = app.CreateClient();
        var statuses = new List<HttpStatusCode>();
        for (int i = 0; i < 20; i++)
            statuses.Add((await anonymous.GetAsync($"/api/v1/share/faux-{i}/access")).StatusCode);
        statuses.Take(10).Should().OnlyContain(s => s == HttpStatusCode.Forbidden);
        statuses.Should().Contain(HttpStatusCode.TooManyRequests);
    }
}
