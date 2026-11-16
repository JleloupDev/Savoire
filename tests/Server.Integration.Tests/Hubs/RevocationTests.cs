// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Droits retires pendant qu'une connexion est ouverte (revue du 14/11/2026,
// M7) : la connexion ne recoit plus rien du vault ou du document, et elle
// en est prevenue. Un droit a date de fin cesse a cette date.
// Et : publier sur le web est reserve aux administrateurs du vault.

using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using FluentAssertions;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.DependencyInjection;
using Savoire.Application.Common;
using Savoire.Infrastructure.Services;

namespace Savoire.Server.Integration.Tests.Hubs;

[Collection("Integration")]
public class RevocationTests : IClassFixture<AppFactory>
{
    private readonly AppFactory _factory;
    public RevocationTests(AppFactory factory) => _factory = factory;

    private static string Uid() => Guid.NewGuid().ToString("N")[..8];
    private static string B64(string s) => Convert.ToBase64String(Encoding.UTF8.GetBytes(s));

    private HttpClient Authed(string token)
    {
        HttpClient c = _factory.CreateClient();
        c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return c;
    }

    private HubConnection Connect(string hub, string token) =>
        new HubConnectionBuilder()
            .WithUrl($"http://localhost/hubs/{hub}", options =>
            {
                options.HttpMessageHandlerFactory = _ => _factory.Server.CreateHandler();
                options.Transports = HttpTransportType.LongPolling;
                options.AccessTokenProvider = () => Task.FromResult<string?>(token);
            })
            .Build();

    private sealed record Setup(string OwnerToken, string OwnerId, string GuestToken, string GuestId, string VaultId, string DocId);

    private async Task<Setup> VaultWithGuestAsync(DateTime? expiresAt = null)
    {
        string uid = Uid();
        (string ownerToken, string ownerId) = await _factory.CreateUserAndGetTokenAsync($"rev-owner-{uid}@test.com", displayName: "Owner");
        (string guestToken, string guestId) = await _factory.CreateUserAndGetTokenAsync($"rev-guest-{uid}@test.com", displayName: "Guest");
        HttpClient owner = Authed(ownerToken);
        var created = await owner.PostAsJsonAsync($"/api/v1/users/{ownerId}/vaults", new { name = "Vault" });
        string vaultId = (await created.Content.ReadFromJsonAsync<VaultSummaryDto>())!.Id;
        (await owner.PostAsJsonAsync($"/api/v1/vaults/{vaultId}/sharing/permissions",
            new { subjectId = guestId, permission = "write", expiresAt })).EnsureSuccessStatusCode();
        string docId = await _factory.NewDocumentAsync(ownerToken, vaultId);
        return new Setup(ownerToken, ownerId, guestToken, guestId, vaultId, docId);
    }

    /// <summary>Attend une condition (diffusions asynchrones).</summary>
    private static async Task Eventually(Func<bool> condition, int ms = 3000)
    {
        for (int waited = 0; waited < ms && !condition(); waited += 50) await Task.Delay(50);
    }

    [Fact(DisplayName = "Membre retire : ses connexions ouvertes ne recoivent plus rien, et sont prevenues")]
    public async Task RemovedMember_StopsReceiving()
    {
        Setup s = await VaultWithGuestAsync();
        await using var guestVault = Connect("vault", s.GuestToken);
        await using var guestDoc = Connect("sync", s.GuestToken);
        var received = new List<string>();
        var revoked = new List<string>();
        guestVault.On<string, string>("VaultOperationReceived", (_, op) => received.Add("vault:" + op));
        guestDoc.On<string, string, string>("ReceiveOperation", (_, _, op) => received.Add("doc:" + op));
        guestVault.On<string, string>("AccessRevoked", (id, _) => revoked.Add(id));
        guestDoc.On<string, string>("AccessRevoked", (id, _) => revoked.Add(id));
        await guestVault.StartAsync(); await guestDoc.StartAsync();
        await guestVault.InvokeAsync("JoinVault", s.VaultId);
        await guestDoc.InvokeAsync("JoinDocument", s.VaultId, s.DocId);

        await using var owner = Connect("vault", s.OwnerToken);
        await using var ownerDoc = Connect("sync", s.OwnerToken);
        await owner.StartAsync(); await ownerDoc.StartAsync();
        await owner.InvokeAsync("JoinVault", s.VaultId);
        await ownerDoc.InvokeAsync("JoinDocument", s.VaultId, s.DocId);
        await owner.InvokeAsync("PushVaultOperation", s.VaultId, B64("avant"));
        await Eventually(() => received.Count >= 1);
        received.Should().Contain("vault:" + B64("avant"), "temoin : avant le retrait, la diffusion arrive");

        (await Authed(s.OwnerToken).DeleteAsync($"/api/v1/vaults/{s.VaultId}/sharing/permissions/{s.GuestId}"))
            .StatusCode.Should().Be(HttpStatusCode.NoContent);
        await Eventually(() => revoked.Count >= 2);
        revoked.Should().Contain([s.VaultId, s.DocId]);

        received.Clear();
        await owner.InvokeAsync("PushVaultOperation", s.VaultId, B64("apres"));
        await ownerDoc.InvokeAsync("PushOperation", s.VaultId, s.DocId, "o", B64("apres-doc"));
        await Task.Delay(400);
        received.Should().BeEmpty("un membre retire ne recoit plus les modifications des autres");
    }

    [Fact(DisplayName = "Droit a date de fin : refuse des l'expiration, puis retire et la connexion sortie")]
    public async Task ExpiredGrant_IsEnforced()
    {
        Setup s = await VaultWithGuestAsync(expiresAt: DateTime.UtcNow.AddSeconds(2));
        await using var guest = Connect("vault", s.GuestToken);
        var received = new List<string>();
        var revoked = new List<string>();
        guest.On<string, string>("VaultOperationReceived", (_, op) => received.Add(op));
        guest.On<string, string>("AccessRevoked", (id, _) => revoked.Add(id));
        await guest.StartAsync();
        await guest.InvokeAsync("JoinVault", s.VaultId);

        await Task.Delay(2500);
        // Expire : refuse tout de suite, avant meme le balayage.
        var join = () => guest.InvokeAsync("CheckVaultAccess", s.VaultId);
        await join.Should().ThrowAsync<HubException>();
        (await Authed(s.GuestToken).GetAsync($"/api/v1/vaults/{s.VaultId}/members/identities")).StatusCode
            .Should().NotBe(HttpStatusCode.OK);

        // Le balayage le retire et coupe la diffusion.
        int swept = await _factory.Services.GetRequiredService<ExpiredPermissionSweeper>().SweepAsync(CancellationToken.None);
        swept.Should().BeGreaterThanOrEqualTo(1);
        await Eventually(() => revoked.Count >= 1);
        revoked.Should().Contain(s.VaultId);

        await using var owner = Connect("vault", s.OwnerToken);
        await owner.StartAsync();
        await owner.InvokeAsync("JoinVault", s.VaultId);
        await owner.InvokeAsync("PushVaultOperation", s.VaultId, B64("apres-expiration"));
        await Task.Delay(400);
        received.Should().BeEmpty();
        var workspace = await Authed(s.GuestToken).GetFromJsonAsync<WorkspaceDto>($"/api/v1/users/{s.GuestId}/vaults");
        workspace!.Vaults.Should().NotContain(v => v.Id == s.VaultId);
    }

    [Fact(DisplayName = "Lien de partage revoque : la connexion ouverte par lui ne recoit plus rien")]
    public async Task RevokedLink_StopsReceiving()
    {
        Setup s = await VaultWithGuestAsync();
        HttpClient owner = Authed(s.OwnerToken);
        var link = await (await owner.PostAsJsonAsync($"/api/v1/documents/{s.DocId}/sharing/links", new { permission = "read" }))
            .Content.ReadFromJsonAsync<ShareLinkDto>();
        var access = await (await _factory.CreateClient().GetAsync($"/api/v1/share/{Uri.EscapeDataString(link!.Token)}/access"))
            .Content.ReadFromJsonAsync<ShareLinkAccessDto>();

        await using var viaLink = Connect("sync", access!.AccessToken);
        var received = new List<string>();
        var revoked = new List<string>();
        viaLink.On<string, string, string>("ReceiveOperation", (_, _, op) => received.Add(op));
        viaLink.On<string, string>("AccessRevoked", (id, _) => revoked.Add(id));
        await viaLink.StartAsync();
        await viaLink.InvokeAsync("JoinDocument", s.VaultId, s.DocId);

        (await owner.DeleteAsync($"/api/v1/sharing/links/{link.Id}")).StatusCode.Should().Be(HttpStatusCode.NoContent);
        await Eventually(() => revoked.Count >= 1);
        revoked.Should().Contain(s.DocId);

        await using var ownerDoc = Connect("sync", s.OwnerToken);
        await ownerDoc.StartAsync();
        await ownerDoc.InvokeAsync("JoinDocument", s.VaultId, s.DocId);
        await ownerDoc.InvokeAsync("PushOperation", s.VaultId, s.DocId, "o", B64("apres"));
        await Task.Delay(400);
        received.Should().BeEmpty();
    }

    [Fact(DisplayName = "Compte bloque : ses connexions ouvertes ne recoivent plus rien")]
    public async Task DisabledAccount_StopsReceiving()
    {
        Setup s = await VaultWithGuestAsync();
        await using var guest = Connect("vault", s.GuestToken);
        var received = new List<string>();
        guest.On<string, string>("VaultOperationReceived", (_, op) => received.Add(op));
        await guest.StartAsync();
        await guest.InvokeAsync("JoinVault", s.VaultId);

        HttpClient admin = await _factory.CreateAdminClientAsync();
        (await admin.PostAsync($"/api/v1/admin/users/{s.GuestId}/disable", null)).StatusCode.Should().Be(HttpStatusCode.NoContent);
        await Task.Delay(300);

        await using var owner = Connect("vault", s.OwnerToken);
        await owner.StartAsync();
        await owner.InvokeAsync("JoinVault", s.VaultId);
        await owner.InvokeAsync("PushVaultOperation", s.VaultId, B64("apres-blocage"));
        await Task.Delay(400);
        received.Should().BeEmpty();
    }

    // ── Publier sur le web : administrateurs du vault ───────────────────────

    [Fact(DisplayName = "Publier : reserve aux administrateurs ; un redacteur met a jour une page deja publiee")]
    public async Task Publish_IsAdminOnly()
    {
        Setup s = await VaultWithGuestAsync();
        object page = new { title = "Page", description = "", html = "<p>v1</p>", indexable = false };
        string url = $"/api/v1/vaults/{s.VaultId}/documents/{s.DocId}/publication";
        HttpClient editor = Authed(s.GuestToken);

        (await editor.PutAsJsonAsync(url, page)).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await editor.PutAsJsonAsync(url + "/content", page)).StatusCode.Should().Be(HttpStatusCode.NotFound, "rien a mettre a jour");

        var published = await Authed(s.OwnerToken).PutAsJsonAsync(url, page);
        published.StatusCode.Should().Be(HttpStatusCode.OK);
        string slug = (await published.Content.ReadFromJsonAsync<System.Text.Json.Nodes.JsonObject>())!["slug"]!.GetValue<string>();

        (await editor.PutAsJsonAsync(url + "/content", new { title = "Page", description = "", html = "<p>v2 par un redacteur</p>" }))
            .StatusCode.Should().Be(HttpStatusCode.OK);
        (await _factory.CreateClient().GetStringAsync($"/p/{slug}")).Should().Contain("v2 par un redacteur");
        (await editor.DeleteAsync(url)).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await Authed(s.OwnerToken).DeleteAsync(url)).StatusCode.Should().Be(HttpStatusCode.NoContent);
    }
}
