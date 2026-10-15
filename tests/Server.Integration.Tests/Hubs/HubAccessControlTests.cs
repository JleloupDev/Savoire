// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Controle d'acces des hubs temps reel.
//
// Etre connecte ne suffit pas : il faut le droit sur CE vault ou CE document.
// Un intrus authentifie, non membre, ne doit ni entrer, ni ecrire, ni recevoir
// les diffusions. Un lien de partage vers une note n'ouvre que cette note.

using System.Net.Http.Headers;
using System.Net.Http.Json;
using FluentAssertions;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Savoire.Application.Common;

namespace Savoire.Server.Integration.Tests.Hubs;

[Collection("Integration")]
public class HubAccessControlTests : IClassFixture<AppFactory>, IAsyncLifetime
{
    private readonly AppFactory _factory;
    private string _ownerToken = null!;
    private string _intruderToken = null!;
    private string _intruderId = null!;
    private string _vaultId = null!;
    private HttpClient _owner = null!;

    public HubAccessControlTests(AppFactory factory) => _factory = factory;

    public async Task InitializeAsync()
    {
        var uid = Guid.NewGuid().ToString("N")[..8];
        (_ownerToken, var ownerId) = await _factory.CreateUserAndGetTokenAsync($"acl-owner-{uid}@test.com", displayName: "Owner");
        (_intruderToken, _intruderId) = await _factory.CreateUserAndGetTokenAsync($"acl-intruder-{uid}@test.com", displayName: "Intruder");

        _owner = _factory.CreateClient();
        _owner.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", _ownerToken);
        var vaultResp = await _owner.PostAsJsonAsync($"/api/v1/users/{ownerId}/vaults", new { name = "Vault prive" });
        vaultResp.EnsureSuccessStatusCode();
        _vaultId = (await vaultResp.Content.ReadFromJsonAsync<VaultSummaryDto>())!.Id;
    }

    public Task DisposeAsync() => Task.CompletedTask;

    private HubConnection Connect(string hub, string token) =>
        new HubConnectionBuilder()
            .WithUrl($"http://localhost/hubs/{hub}", options =>
            {
                options.HttpMessageHandlerFactory = _ => _factory.Server.CreateHandler();
                options.Transports = HttpTransportType.LongPolling;
                options.AccessTokenProvider = () => Task.FromResult<string?>(token);
            })
            .Build();

    private static string B64(string s) => Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(s));

    // ── VaultHub ──────────────────────────────────────────────────────────────

    [Fact(DisplayName = "VaultHub — un non-membre ne peut pas entrer dans le vault")]
    public async Task JoinVault_NonMember_IsRejected()
    {
        await using var intruder = Connect("vault", _intruderToken);
        await intruder.StartAsync();
        var act = () => intruder.InvokeAsync("JoinVault", _vaultId);
        await act.Should().ThrowAsync<HubException>();
    }

    [Fact(DisplayName = "VaultHub — un non-membre refuse ne recoit pas les operations du vault")]
    public async Task JoinVault_NonMember_DoesNotReceiveOperations()
    {
        await using var intruder = Connect("vault", _intruderToken);
        await using var owner = Connect("vault", _ownerToken);
        var leaked = false;
        intruder.On<string, string>("VaultOperationReceived", (_, _) => leaked = true);
        await intruder.StartAsync();
        await owner.StartAsync();

        try { await intruder.InvokeAsync("JoinVault", _vaultId); } catch (HubException) { }
        await owner.InvokeAsync("JoinVault", _vaultId);
        await owner.InvokeAsync("PushVaultOperation", _vaultId, B64("op"));
        await Task.Delay(300);

        leaked.Should().BeFalse();
    }

    [Fact(DisplayName = "VaultHub — un non-membre ne peut pas modifier le repertoire du vault")]
    public async Task PushVaultOperation_NonMember_IsRejected()
    {
        await using var intruder = Connect("vault", _intruderToken);
        await intruder.StartAsync();
        var act = () => intruder.InvokeAsync("PushVaultOperation", _vaultId, B64("op"));
        await act.Should().ThrowAsync<HubException>();
    }

    [Fact(DisplayName = "VaultHub — un non-membre ne peut ni lire ni ecrire une carte partagee (commentaires, discussions)")]
    public async Task IndexChannel_NonMember_IsRejected()
    {
        await using var intruder = Connect("vault", _intruderToken);
        await intruder.StartAsync();
        var join = () => intruder.InvokeAsync<string[]>("JoinIndex", _vaultId, "map/review");
        var push = () => intruder.InvokeAsync("PushIndexUpdate", _vaultId, "map/review", B64("x"));
        await join.Should().ThrowAsync<HubException>();
        await push.Should().ThrowAsync<HubException>();
    }

    [Fact(DisplayName = "VaultHub — le proprietaire lit et ecrit toujours ses cartes partagees")]
    public async Task IndexChannel_Owner_IsAllowed()
    {
        await using var owner = Connect("vault", _ownerToken);
        await owner.StartAsync();
        await owner.InvokeAsync("PushIndexUpdate", _vaultId, "map/review", B64("x"));
        var ops = await owner.InvokeAsync<string[]>("JoinIndex", _vaultId, "map/review");
        ops.Should().ContainSingle();
    }

    [Fact(DisplayName = "VaultHub — un non-membre ne peut pas prendre un verrou")]
    public async Task AcquireLock_NonMember_IsRejected()
    {
        await using var intruder = Connect("vault", _intruderToken);
        await intruder.StartAsync();
        var act = () => intruder.InvokeAsync<object>("AcquireLock", _vaultId, Guid.NewGuid().ToString());
        await act.Should().ThrowAsync<HubException>();
    }

    // ── DocumentRoomHub ───────────────────────────────────────────────────────

    [Fact(DisplayName = "DocumentRoomHub — un non-membre ne peut ni entrer ni ecrire un snapshot")]
    public async Task Room_NonMember_IsRejected()
    {
        var docId = await _factory.NewDocumentAsync(_ownerToken, _vaultId);
        await using var owner = Connect("room", _ownerToken);
        await using var intruder = Connect("room", _intruderToken);
        var received = false;
        owner.On<string, string, string>("SnapshotReceived", (_, _, _) => received = true);
        await owner.StartAsync();
        await intruder.StartAsync();
        await owner.InvokeAsync("JoinRoom", _vaultId, docId);

        var join = () => intruder.InvokeAsync("JoinRoom", _vaultId, docId);
        var push = () => intruder.InvokeAsync("PushSnapshot", _vaultId, docId, "{\"pirate\":true}");
        await join.Should().ThrowAsync<HubException>();
        await push.Should().ThrowAsync<HubException>();
        await Task.Delay(300);
        received.Should().BeFalse();
    }

    // ── Registre « document -> vault » ────────────────────────────────────────

    /// <summary>Vault de l'intrus : il en est proprietaire, donc il y a tous les droits.</summary>
    private async Task<string> IntruderVaultAsync()
    {
        var http = _factory.CreateClient();
        http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", _intruderToken);
        var resp = await http.PostAsJsonAsync($"/api/v1/users/{_intruderId}/vaults", new { name = "Vault intrus" });
        resp.EnsureSuccessStatusCode();
        return (await resp.Content.ReadFromJsonAsync<VaultSummaryDto>())!.Id;
    }

    [Fact(DisplayName = "Registre — annoncer SON vault avec le document d'un autre vault est refuse")]
    public async Task OwnVault_WithForeignDocument_IsRejected()
    {
        var victimDoc = await _factory.NewDocumentAsync(_ownerToken, _vaultId);
        var intruderVault = await IntruderVaultAsync();

        await using var sync = Connect("sync", _intruderToken);
        await using var room = Connect("room", _intruderToken);
        await sync.StartAsync();
        await room.StartAsync();

        var join  = () => sync.InvokeAsync("JoinDocument", intruderVault, victimDoc);
        var push  = () => sync.InvokeAsync("PushOperation", intruderVault, victimDoc, "c", B64("op"));
        var enter = () => room.InvokeAsync("JoinRoom", intruderVault, victimDoc);
        await join.Should().ThrowAsync<HubException>();
        await push.Should().ThrowAsync<HubException>();
        await enter.Should().ThrowAsync<HubException>();
    }

    [Fact(DisplayName = "Registre — un document deja dans un vault ne peut pas etre inscrit dans un autre")]
    public async Task RegisterForeignDocument_IsRejected()
    {
        var victimDoc = await _factory.NewDocumentAsync(_ownerToken, _vaultId);
        var intruderVault = await IntruderVaultAsync();

        await using var vault = Connect("vault", _intruderToken);
        await vault.StartAsync();
        var rejected = await vault.InvokeAsync<string[]>("RegisterDocuments", intruderVault, new[] { victimDoc });
        rejected.Should().Equal(victimDoc);
    }

    [Fact(DisplayName = "Registre — un document jamais inscrit est refuse, meme au proprietaire du vault")]
    public async Task UnregisteredDocument_IsRejected()
    {
        await using var sync = Connect("sync", _ownerToken);
        await sync.StartAsync();
        var join = () => sync.InvokeAsync("JoinDocument", _vaultId, Guid.NewGuid().ToString());
        await join.Should().ThrowAsync<HubException>();
    }

    [Fact(DisplayName = "Partage — on ne cree pas de lien vers le document d'un vault qu'on n'administre pas")]
    public async Task ShareLinkOnForeignDocument_IsForbidden()
    {
        var victimDoc = await _factory.NewDocumentAsync(_ownerToken, _vaultId);
        var intruder = _factory.CreateClient();
        intruder.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", _intruderToken);
        var resp = await intruder.PostAsJsonAsync($"/api/v1/documents/{victimDoc}/sharing/links", new { permission = "write" });
        ((int)resp.StatusCode).Should().BeOneOf(403, 404);
    }

    // ── Liens de partage ──────────────────────────────────────────────────────

    [Fact(DisplayName = "SyncHub — un lien vers UNE note n'ouvre pas les autres notes")]
    public async Task DocumentShareLink_OpensOnlyItsDocument()
    {
        var sharedDoc = await _factory.NewDocumentAsync(_ownerToken, _vaultId);
        var otherDoc  = await _factory.NewDocumentAsync(_ownerToken, _vaultId);
        var linkResp = await _owner.PostAsJsonAsync($"/api/v1/documents/{sharedDoc}/sharing/links", new { permission = "read" });
        linkResp.EnsureSuccessStatusCode();
        var link = await linkResp.Content.ReadFromJsonAsync<ShareLinkDto>();
        var access = await (await _factory.CreateClient().GetAsync($"/api/v1/share/{link!.Token}/access"))
            .Content.ReadFromJsonAsync<ShareLinkAccessDto>();

        await using var viaLink = Connect("sync", access!.AccessToken);
        await viaLink.StartAsync();

        await viaLink.InvokeAsync("JoinDocument", _vaultId, sharedDoc);
        var other = () => viaLink.InvokeAsync("JoinDocument", _vaultId, otherDoc);
        await other.Should().ThrowAsync<HubException>();
    }

    [Fact(DisplayName = "SyncHub — un lien en lecture ne permet pas d'ecrire")]
    public async Task ReadShareLink_CannotWrite()
    {
        var sharedDoc = await _factory.NewDocumentAsync(_ownerToken, _vaultId);
        var linkResp = await _owner.PostAsJsonAsync($"/api/v1/documents/{sharedDoc}/sharing/links", new { permission = "read" });
        var link = await linkResp.Content.ReadFromJsonAsync<ShareLinkDto>();
        var access = await (await _factory.CreateClient().GetAsync($"/api/v1/share/{link!.Token}/access"))
            .Content.ReadFromJsonAsync<ShareLinkAccessDto>();

        await using var viaLink = Connect("sync", access!.AccessToken);
        await viaLink.StartAsync();
        var push = () => viaLink.InvokeAsync("PushOperation", _vaultId, sharedDoc, "client", B64("op"));
        await push.Should().ThrowAsync<HubException>();
    }
}
