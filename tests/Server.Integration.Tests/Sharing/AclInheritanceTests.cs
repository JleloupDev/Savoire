// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Droits herites et surcharges (AclResolver) : un document a les droits de
// son dossier, un dossier ceux de son parent, le tout ceux des membres du
// vault ; chaque niveau peut les changer pour une personne, ou cesser
// d'heriter. Le proprietaire et les administrateurs gardent tout.

using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;
using FluentAssertions;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Savoire.Application.Common;

namespace Savoire.Server.Integration.Tests.Sharing;

[Collection("Integration")]
public class AclInheritanceTests : IClassFixture<AppFactory>
{
    private readonly AppFactory _factory;
    public AclInheritanceTests(AppFactory factory) => _factory = factory;

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

    /// <summary>Un vault, son proprietaire, un redacteur, un lecteur, un compte exterieur ; des notes rangees.</summary>
    private sealed record World(
        string VaultId,
        (string Token, string Id) Owner, (string Token, string Id) Editor, (string Token, string Id) Viewer, (string Token, string Id) Outsider,
        string Root, string InProjects, string InSecret);

    private async Task<World> WorldAsync()
    {
        string uid = Uid();
        var owner = await _factory.CreateUserAndGetTokenAsync($"acl-owner-{uid}@test.com", displayName: "Owner");
        var editor = await _factory.CreateUserAndGetTokenAsync($"acl-editor-{uid}@test.com", displayName: "Editor");
        var viewer = await _factory.CreateUserAndGetTokenAsync($"acl-viewer-{uid}@test.com", displayName: "Viewer");
        var outsider = await _factory.CreateUserAndGetTokenAsync($"acl-out-{uid}@test.com", displayName: "Outsider");
        HttpClient o = Authed(owner.token);
        string vaultId = (await (await o.PostAsJsonAsync($"/api/v1/users/{owner.userId}/vaults", new { name = "Vault" }))
            .Content.ReadFromJsonAsync<VaultSummaryDto>())!.Id;
        (await o.PostAsJsonAsync($"/api/v1/vaults/{vaultId}/members", new { userId = editor.userId, role = "editor" })).EnsureSuccessStatusCode();
        (await o.PostAsJsonAsync($"/api/v1/vaults/{vaultId}/members", new { userId = viewer.userId, role = "viewer" })).EnsureSuccessStatusCode();
        string root = await _factory.NewDocumentAsync(owner.token, vaultId);
        string inProjects = await _factory.NewDocumentAsync(owner.token, vaultId);
        string inSecret = await _factory.NewDocumentAsync(owner.token, vaultId);
        await PlaceAsync(o, vaultId, (root, ""), (inProjects, "Projets"), (inSecret, "Projets/Secret"));
        return new World(vaultId, owner, editor, viewer, outsider, root, inProjects, inSecret);
    }

    private static async Task<JsonArray> PlaceAsync(HttpClient client, string vaultId, params (string DocId, string Folder)[] docs)
    {
        var resp = await client.PutAsJsonAsync($"/api/v1/vaults/{vaultId}/documents/folders", docs.Select(d => new { docId = d.DocId, folder = d.Folder }));
        resp.EnsureSuccessStatusCode();
        return (await resp.Content.ReadFromJsonAsync<JsonObject>())!["rejected"]!.AsArray();
    }

    private static Task<HttpResponseMessage> EntryAsync(HttpClient client, string vaultId, string subjectId, string permission, string? folder = null, string? docId = null) =>
        client.PutAsJsonAsync($"/api/v1/vaults/{vaultId}/acl/entries", new { docId, folder, subjectId, permission });

    private static Task<HttpResponseMessage> InheritAsync(HttpClient client, string vaultId, bool inherit, string? folder = null, string? docId = null) =>
        client.PutAsJsonAsync($"/api/v1/vaults/{vaultId}/acl/inherit", new { docId, folder, inherit });

    /// <summary>Ce que la personne peut faire du document : "none", "read" ou "write".</summary>
    private async Task<string> AccessAsync(string token, string vaultId, string docId)
    {
        await using var sync = Connect("sync", token);
        await sync.StartAsync();
        try { await sync.InvokeAsync("JoinDocument", vaultId, docId); }
        catch (HubException) { return "none"; }
        try { await sync.InvokeAsync("PushOperation", vaultId, docId, "c", B64("x")); }
        catch (HubException) { return "read"; }
        return "write";
    }

    [Fact(DisplayName = "Par defaut, tout herite du vault : redacteur ecrit, lecteur lit, exterieur rien")]
    public async Task Default_InheritsVault()
    {
        World w = await WorldAsync();
        (await AccessAsync(w.Editor.Token, w.VaultId, w.InSecret)).Should().Be("write");
        (await AccessAsync(w.Viewer.Token, w.VaultId, w.InSecret)).Should().Be("read");
        (await AccessAsync(w.Outsider.Token, w.VaultId, w.InSecret)).Should().Be("none");
    }

    [Fact(DisplayName = "Un droit sur un dossier vaut pour tout ce qu'il contient, sous-dossiers compris")]
    public async Task FolderEntry_IsInherited()
    {
        World w = await WorldAsync();
        HttpClient o = Authed(w.Owner.Token);
        (await EntryAsync(o, w.VaultId, w.Editor.Id, "none", folder: "Projets")).StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await EntryAsync(o, w.VaultId, w.Viewer.Id, "write", folder: "Projets")).StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await EntryAsync(o, w.VaultId, w.Outsider.Id, "read", folder: "Projets/Secret")).StatusCode.Should().Be(HttpStatusCode.NoContent);

        (await AccessAsync(w.Editor.Token, w.VaultId, w.InProjects)).Should().Be("none", "« aucun acces » sur le dossier");
        (await AccessAsync(w.Editor.Token, w.VaultId, w.InSecret)).Should().Be("none", "herite du dossier parent");
        (await AccessAsync(w.Editor.Token, w.VaultId, w.Root)).Should().Be("write", "hors du dossier, rien ne change");
        (await AccessAsync(w.Viewer.Token, w.VaultId, w.InSecret)).Should().Be("write", "plus de droit que dans le vault");
        (await AccessAsync(w.Viewer.Token, w.VaultId, w.Root)).Should().Be("read");
        (await AccessAsync(w.Outsider.Token, w.VaultId, w.InSecret)).Should().Be("read", "un exterieur invite sur un dossier");
        (await AccessAsync(w.Outsider.Token, w.VaultId, w.InProjects)).Should().Be("none");
    }

    [Fact(DisplayName = "Le plus precis l'emporte : un droit sur une note surcharge celui de son dossier")]
    public async Task DocumentEntry_OverridesFolder()
    {
        World w = await WorldAsync();
        HttpClient o = Authed(w.Owner.Token);
        await EntryAsync(o, w.VaultId, w.Editor.Id, "none", folder: "Projets");
        (await EntryAsync(o, w.VaultId, w.Editor.Id, "read", docId: w.InSecret)).StatusCode.Should().Be(HttpStatusCode.NoContent);

        (await AccessAsync(w.Editor.Token, w.VaultId, w.InSecret)).Should().Be("read");
        (await AccessAsync(w.Editor.Token, w.VaultId, w.InProjects)).Should().Be("none");

        (await o.DeleteAsync($"/api/v1/vaults/{w.VaultId}/acl/entries?folder=Projets&subjectId={w.Editor.Id}")).StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await AccessAsync(w.Editor.Token, w.VaultId, w.InProjects)).Should().Be("write", "le droit retire, l'heritage revient");
    }

    [Fact(DisplayName = "Un dossier qui n'herite plus : seuls ses propres droits valent ; proprietaire et administrateurs gardent tout")]
    public async Task BrokenInheritance()
    {
        World w = await WorldAsync();
        HttpClient o = Authed(w.Owner.Token);
        string uid = Uid();
        var admin = await _factory.CreateUserAndGetTokenAsync($"acl-admin-{uid}@test.com", displayName: "Admin");
        (await o.PostAsJsonAsync($"/api/v1/vaults/{w.VaultId}/sharing/permissions", new { subjectId = admin.userId, permission = "admin" })).EnsureSuccessStatusCode();

        (await InheritAsync(o, w.VaultId, false, folder: "Projets/Secret")).StatusCode.Should().Be(HttpStatusCode.NoContent);
        await EntryAsync(o, w.VaultId, w.Viewer.Id, "read", folder: "Projets/Secret");

        (await AccessAsync(w.Editor.Token, w.VaultId, w.InSecret)).Should().Be("none");
        (await AccessAsync(w.Viewer.Token, w.VaultId, w.InSecret)).Should().Be("read");
        (await AccessAsync(w.Owner.Token, w.VaultId, w.InSecret)).Should().Be("write");
        (await AccessAsync(admin.token, w.VaultId, w.InSecret)).Should().Be("write");
        (await AccessAsync(w.Editor.Token, w.VaultId, w.InProjects)).Should().Be("write", "le dossier parent herite toujours");

        await InheritAsync(o, w.VaultId, true, folder: "Projets/Secret");
        (await AccessAsync(w.Editor.Token, w.VaultId, w.InSecret)).Should().Be("write");
    }

    [Fact(DisplayName = "Seuls le proprietaire et les administrateurs gerent les droits ; personne ne prive le proprietaire")]
    public async Task OnlyAdminsManage()
    {
        World w = await WorldAsync();
        HttpClient editor = Authed(w.Editor.Token);
        (await EntryAsync(editor, w.VaultId, w.Viewer.Id, "write", folder: "Projets")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await InheritAsync(editor, w.VaultId, false, folder: "Projets")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await editor.GetAsync($"/api/v1/vaults/{w.VaultId}/acl?folder=Projets")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await EntryAsync(Authed(w.Owner.Token), w.VaultId, w.Owner.Id, "none", folder: "Projets")).StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await EntryAsync(Authed(w.Owner.Token), w.VaultId, w.Editor.Id, "none", folder: "../ailleurs")).StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact(DisplayName = "La vue des droits montre ce qui est herite, d'ou, et ce qui est donne ici")]
    public async Task AclView()
    {
        World w = await WorldAsync();
        HttpClient o = Authed(w.Owner.Token);
        await EntryAsync(o, w.VaultId, w.Viewer.Id, "write", folder: "Projets");
        await EntryAsync(o, w.VaultId, w.Editor.Id, "none", docId: w.InSecret);

        JsonObject view = (await o.GetFromJsonAsync<JsonObject>($"/api/v1/vaults/{w.VaultId}/acl?docId={w.InSecret}"))!;
        view["level"]!.GetValue<string>().Should().Be("document");
        view["inherit"]!.GetValue<bool>().Should().BeTrue();
        view["entries"]!.AsArray().Should().ContainSingle(e => e!["subjectId"]!.GetValue<string>() == w.Editor.Id && e["permission"]!.GetValue<string>() == "none");
        JsonArray inherited = view["inherited"]!.AsArray();
        inherited.Should().Contain(e => e!["subjectId"]!.GetValue<string>() == w.Viewer.Id
            && e["permission"]!.GetValue<string>() == "write" && e["source"]!.GetValue<string>() == "folder:Projets");
        inherited.Should().Contain(e => e!["subjectId"]!.GetValue<string>() == w.Editor.Id
            && e["permission"]!.GetValue<string>() == "write" && e["source"]!.GetValue<string>() == "vault");
        inherited.Should().Contain(e => e!["subjectId"]!.GetValue<string>() == w.Owner.Id && e["source"]!.GetValue<string>() == "owner");
        inherited.Should().NotContain(e => e!["subjectId"]!.GetValue<string>() == w.Outsider.Id);
    }

    [Fact(DisplayName = "Deplacer : on ne sort pas une note d'un dossier ou on n'a pas le droit ; renommer un dossier emporte ses droits")]
    public async Task Moves()
    {
        World w = await WorldAsync();
        HttpClient o = Authed(w.Owner.Token);
        await EntryAsync(o, w.VaultId, w.Editor.Id, "read", folder: "Projets/Secret");

        // Le redacteur ne peut pas sortir la note de Secret (il n'y ecrit pas) ni y deplacer une note.
        JsonArray rejected = await PlaceAsync(Authed(w.Editor.Token), w.VaultId, (w.InSecret, ""), (w.Root, "Projets/Secret"));
        rejected.Select(r => r!.GetValue<string>()).Should().BeEquivalentTo([w.InSecret, w.Root]);
        (await AccessAsync(w.Editor.Token, w.VaultId, w.InSecret)).Should().Be("read");

        // Renommer « Projets » en « Archives/Projets » : la note et ses droits suivent.
        (await o.PostAsJsonAsync($"/api/v1/vaults/{w.VaultId}/acl/folders/rename", new { from = "Projets", to = "Archives/Projets" }))
            .StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await AccessAsync(w.Editor.Token, w.VaultId, w.InSecret)).Should().Be("read");
        JsonObject view = (await o.GetFromJsonAsync<JsonObject>($"/api/v1/vaults/{w.VaultId}/acl?folder=Archives/Projets/Secret"))!;
        view["entries"]!.AsArray().Should().ContainSingle(e => e!["subjectId"]!.GetValue<string>() == w.Editor.Id);

        // Le proprietaire, lui, sort la note : elle reprend les droits du vault.
        (await PlaceAsync(o, w.VaultId, (w.InSecret, ""))).Should().BeEmpty();
        (await AccessAsync(w.Editor.Token, w.VaultId, w.InSecret)).Should().Be("write");
    }

    [Fact(DisplayName = "Une connexion ouverte perd la note des que le droit est retire")]
    public async Task OpenConnection_IsCut()
    {
        World w = await WorldAsync();
        await using var editor = Connect("sync", w.Editor.Token);
        var received = new List<string>();
        var revoked = new List<string>();
        editor.On<string, string, string, System.Text.Json.JsonElement>("ReceiveOperation", (_, _, op, _) => received.Add(op));
        editor.On<string, string>("AccessRevoked", (id, _) => revoked.Add(id));
        await editor.StartAsync();
        await editor.InvokeAsync("JoinDocument", w.VaultId, w.InSecret);
        await using var owner = Connect("sync", w.Owner.Token);
        await owner.StartAsync();
        await owner.InvokeAsync("JoinDocument", w.VaultId, w.InSecret);

        // Temoin : avant, la modification arrive bien.
        await owner.InvokeAsync("PushOperation", w.VaultId, w.InSecret, "o", B64("avant"));
        for (int i = 0; i < 60 && received.Count == 0; i++) await Task.Delay(50);
        received.Should().Contain(B64("avant"));
        received.Clear();

        (await EntryAsync(Authed(w.Owner.Token), w.VaultId, w.Editor.Id, "none", folder: "Projets")).StatusCode.Should().Be(HttpStatusCode.NoContent);
        for (int i = 0; i < 60 && revoked.Count == 0; i++) await Task.Delay(50);
        revoked.Should().Contain(w.InSecret);

        await owner.InvokeAsync("PushOperation", w.VaultId, w.InSecret, "o", B64("secret"));
        await Task.Delay(400);
        received.Should().BeEmpty();
    }
}
