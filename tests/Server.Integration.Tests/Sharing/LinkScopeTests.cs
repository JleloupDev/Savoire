// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Portee des liens de partage et des jetons de vue (revue du 14/11/2026, C1).
//
// Un lien ou un jeton de vue ne doit ouvrir que ce pour quoi il a ete donne :
//  - un lien vers SON vault n'ouvre pas, par son identifiant, le document
//    d'un autre vault ;
//  - un jeton de vue n'ouvre qu'un document : ni le repertoire du vault, ni
//    ses fichiers, ni son ecriture ;
//  - un jeton de vue ne s'obtient pas pour le vault de quelqu'un d'autre.

using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using FluentAssertions;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Savoire.Application.Common;

namespace Savoire.Server.Integration.Tests.Sharing;

[Collection("Integration")]
public class LinkScopeTests : IClassFixture<AppFactory>, IAsyncLifetime
{
    private readonly AppFactory _factory;
    private string _victimToken = null!;
    private string _attackerToken = null!;
    private string _victimVault = null!;
    private string _attackerVault = null!;
    private HttpClient _victim = null!;
    private HttpClient _attacker = null!;

    public LinkScopeTests(AppFactory factory) => _factory = factory;

    public async Task InitializeAsync()
    {
        var uid = Guid.NewGuid().ToString("N")[..8];
        (_victimToken, var victimId) = await _factory.CreateUserAndGetTokenAsync($"scope-victim-{uid}@test.com", displayName: "Victime");
        (_attackerToken, var attackerId) = await _factory.CreateUserAndGetTokenAsync($"scope-attacker-{uid}@test.com", displayName: "Attaquant");
        _victim = Authed(_victimToken);
        _attacker = Authed(_attackerToken);
        _victimVault = await NewVaultAsync(_victim, victimId, "Vault de la victime");
        _attackerVault = await NewVaultAsync(_attacker, attackerId, "Vault de l'attaquant");
    }

    public Task DisposeAsync() => Task.CompletedTask;

    private HttpClient Authed(string token)
    {
        HttpClient c = _factory.CreateClient();
        c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return c;
    }

    private static async Task<string> NewVaultAsync(HttpClient client, string userId, string name)
    {
        var resp = await client.PostAsJsonAsync($"/api/v1/users/{userId}/vaults", new { name });
        resp.EnsureSuccessStatusCode();
        return (await resp.Content.ReadFromJsonAsync<VaultSummaryDto>())!.Id;
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

    private static string B64(string s) => Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(s));

    /// <summary>Cree un lien et rend son jeton (celui de l'adresse du lien).</summary>
    private static async Task<string> NewLinkAsync(HttpClient owner, string resource, string id, string permission)
    {
        var resp = await owner.PostAsJsonAsync($"/api/v1/{resource}/{id}/sharing/links", new { permission });
        resp.EnsureSuccessStatusCode();
        return (await resp.Content.ReadFromJsonAsync<ShareLinkDto>())!.Token;
    }

    /// <summary>Echange le lien contre son jeton d'acces (ce que fait la page de partage).</summary>
    private async Task<string> LinkAccessTokenAsync(string linkToken)
    {
        var resp = await _factory.CreateClient().GetAsync($"/api/v1/share/{Uri.EscapeDataString(linkToken)}/access");
        resp.EnsureSuccessStatusCode();
        return (await resp.Content.ReadFromJsonAsync<ShareLinkAccessDto>())!.AccessToken;
    }

    private Task<HttpResponseMessage> AskGrantAsync(string linkToken, string vaultId, string docId, string permission) =>
        _factory.CreateClient().PostAsJsonAsync("/api/v1/view/grants",
            new CreateViewGrantRequest(vaultId, docId, "note.md", permission, linkToken));

    /// <summary>Jeton de vue obtenu avec un lien, pour le document de ce lien.</summary>
    private async Task<string> ViewTokenAsync(string linkToken, string vaultId, string docId, string permission)
    {
        var grant = await AskGrantAsync(linkToken, vaultId, docId, permission);
        grant.EnsureSuccessStatusCode();
        var dto = await grant.Content.ReadFromJsonAsync<ViewGrantDto>();
        var redeemed = await _factory.CreateClient().PostAsJsonAsync("/api/v1/view/grants/redeem", new RedeemViewGrantRequest(dto!.GrantToken));
        redeemed.EnsureSuccessStatusCode();
        return (await redeemed.Content.ReadFromJsonAsync<ViewAccessDto>())!.AccessToken;
    }

    // ── Un lien vers son propre vault n'ouvre pas les documents des autres ────

    [Fact(DisplayName = "Lien de SON vault : ne lit pas le document d'un autre vault")]
    public async Task OwnVaultLink_CannotReadForeignDocument()
    {
        string victimDoc = await _factory.NewDocumentAsync(_victimToken, _victimVault);
        await using (var owner = Connect("sync", _victimToken))
        {
            await owner.StartAsync();
            await owner.InvokeAsync("JoinDocument", _victimVault, victimDoc);
            await owner.InvokeAsync("PushOperation", _victimVault, victimDoc, "o", B64("contenu-secret"));
        }
        string access = await LinkAccessTokenAsync(await NewLinkAsync(_attacker, "vaults", _attackerVault, "write"));

        await using var viaLink = Connect("sync", access);
        string[]? leaked = null;
        viaLink.On<string, string[]>("InitDocument", (_, ops) => leaked = ops);
        await viaLink.StartAsync();
        var join = () => viaLink.InvokeAsync("JoinDocument", _attackerVault, victimDoc);

        await join.Should().ThrowAsync<HubException>();
        leaked.Should().BeNull("le contenu d'un document d'un autre vault ne doit jamais partir");
    }

    [Fact(DisplayName = "Lien de SON vault : n'ecrit pas dans le document d'un autre vault")]
    public async Task OwnVaultLink_CannotWriteForeignDocument()
    {
        string victimDoc = await _factory.NewDocumentAsync(_victimToken, _victimVault);
        string access = await LinkAccessTokenAsync(await NewLinkAsync(_attacker, "vaults", _attackerVault, "write"));

        await using var viaLink = Connect("sync", access);
        await viaLink.StartAsync();
        var push = () => viaLink.InvokeAsync("PushOperation", _attackerVault, victimDoc, "x", B64("ecrit-par-l-attaquant"));
        await push.Should().ThrowAsync<HubException>();

        await using var owner = Connect("sync", _victimToken);
        string[] ops = [];
        owner.On<string, string[]>("InitDocument", (_, o) => ops = o);
        await owner.StartAsync();
        await owner.InvokeAsync("JoinDocument", _victimVault, victimDoc);
        ops.Should().NotContain(B64("ecrit-par-l-attaquant"));
    }

    [Fact(DisplayName = "Lien de vault : ouvre toujours les documents de CE vault")]
    public async Task VaultLink_StillOpensItsOwnDocuments()
    {
        string doc = await _factory.NewDocumentAsync(_victimToken, _victimVault);
        string access = await LinkAccessTokenAsync(await NewLinkAsync(_victim, "vaults", _victimVault, "write"));

        await using var viaLink = Connect("sync", access);
        await viaLink.StartAsync();
        await viaLink.InvokeAsync("JoinDocument", _victimVault, doc);
        await viaLink.InvokeAsync("PushOperation", _victimVault, doc, "c", B64("op"));
    }

    // ── Un jeton de vue ne s'obtient que pour le vault du document ────────────

    [Fact(DisplayName = "Jeton de vue : refuse pour le vault d'un autre (lien de sa propre note)")]
    public async Task ViewGrant_ForForeignVault_IsRefused()
    {
        string attackerDoc = await _factory.NewDocumentAsync(_attackerToken, _attackerVault);
        string link = await NewLinkAsync(_attacker, "documents", attackerDoc, "write");

        var grant = await AskGrantAsync(link, _victimVault, attackerDoc, "write");

        grant.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact(DisplayName = "Jeton de vue : un membre ne l'obtient pas pour le document d'un autre vault")]
    public async Task ViewGrant_MemberForForeignDocument_IsRefused()
    {
        string victimDoc = await _factory.NewDocumentAsync(_victimToken, _victimVault);

        var grant = await _attacker.PostAsJsonAsync("/api/v1/view/internal-grants",
            new CreateViewGrantRequest(_attackerVault, victimDoc, "note.md", "write", null));

        grant.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    // ── Un jeton de vue n'ouvre qu'un document ────────────────────────────────

    [Fact(DisplayName = "Jeton de vue : ouvre son document, pas le repertoire du vault")]
    public async Task ViewToken_OpensItsDocument_NotTheVault()
    {
        string sharedDoc = await _factory.NewDocumentAsync(_victimToken, _victimVault);
        string view = await ViewTokenAsync(await NewLinkAsync(_victim, "documents", sharedDoc, "read"), _victimVault, sharedDoc, "read");

        await using var docs = Connect("sync", view);
        await docs.StartAsync();
        await docs.InvokeAsync("JoinDocument", _victimVault, sharedDoc);

        await using var vault = Connect("vault", view);
        string[]? directory = null;
        vault.On<string, string[]>("InitVault", (_, ops) => directory = ops);
        await vault.StartAsync();
        var join = () => vault.InvokeAsync("JoinVault", _victimVault);
        await join.Should().ThrowAsync<HubException>();
        directory.Should().BeNull("le repertoire du vault ne doit pas partir vers un jeton de vue");

        var index = () => vault.InvokeAsync<string[]>("JoinIndex", _victimVault, "metadata");
        await index.Should().ThrowAsync<HubException>();
    }

    [Fact(DisplayName = "Jeton de vue : n'ouvre pas un autre document du meme vault")]
    public async Task ViewToken_CannotOpenAnotherDocument()
    {
        string sharedDoc = await _factory.NewDocumentAsync(_victimToken, _victimVault);
        string otherDoc = await _factory.NewDocumentAsync(_victimToken, _victimVault);
        string view = await ViewTokenAsync(await NewLinkAsync(_victim, "documents", sharedDoc, "read"), _victimVault, sharedDoc, "read");

        await using var docs = Connect("sync", view);
        await docs.StartAsync();
        var join = () => docs.InvokeAsync("JoinDocument", _victimVault, otherDoc);
        await join.Should().ThrowAsync<HubException>();
    }

    [Fact(DisplayName = "Jeton de vue en ecriture : n'ecrit ni le repertoire ni les fichiers du vault")]
    public async Task WriteViewToken_CannotWriteTheVault()
    {
        string sharedDoc = await _factory.NewDocumentAsync(_victimToken, _victimVault);
        string view = await ViewTokenAsync(await NewLinkAsync(_victim, "documents", sharedDoc, "write"), _victimVault, sharedDoc, "write");

        // Il ecrit bien dans SON document...
        await using var docs = Connect("sync", view);
        await docs.StartAsync();
        await docs.InvokeAsync("JoinDocument", _victimVault, sharedDoc);
        await docs.InvokeAsync("PushOperation", _victimVault, sharedDoc, "c", B64("op"));

        // ... mais pas dans le repertoire du vault,
        await using var vault = Connect("vault", view);
        await vault.StartAsync();
        var push = () => vault.InvokeAsync("PushVaultOperation", _victimVault, B64("repertoire-modifie"));
        await push.Should().ThrowAsync<HubException>();
        var register = () => vault.InvokeAsync<string[]>("RegisterDocuments", _victimVault, new[] { Guid.NewGuid().ToString() });
        await register.Should().ThrowAsync<HubException>();

        // ... ni dans ses fichiers.
        using var form = new MultipartFormDataContent { { new ByteArrayContent("x"u8.ToArray()), "file", "a.txt" } };
        var upload = await Authed(view).PostAsync($"/api/v1/vaults/{_victimVault}/attachments", form);
        upload.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }
}
