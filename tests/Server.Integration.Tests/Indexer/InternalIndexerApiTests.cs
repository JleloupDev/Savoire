// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// API interne du pair indexeur (/internal/indexer) : jeton de service, flux
// de changements (ordre, une ligne par ressource, last, filtrage par
// instance, vault supprime ou sorti du pair gere), journaux Yjs.

using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;
using FluentAssertions;
using Microsoft.AspNetCore.SignalR.Client;
using static Savoire.Server.Integration.Tests.Indexer.IndexerTestKit;

namespace Savoire.Server.Integration.Tests.Indexer;

[Collection("Integration")]
public class InternalIndexerApiTests : IClassFixture<IndexerAppFactory>, IAsyncLifetime
{
    private readonly IndexerAppFactory _factory;
    private string _token = null!;
    private string _userId = null!;
    private string _vaultId = null!;
    private string _docId = null!;
    private string _owner = null!;

    public InternalIndexerApiTests(IndexerAppFactory factory) => _factory = factory;

    public async Task InitializeAsync()
    {
        var uid = Guid.NewGuid().ToString("N")[..8];
        (_token, _userId) = await _factory.CreateUserAndGetTokenAsync($"idx-internal-{uid}@test.com", displayName: "Indexer");
        _vaultId = await _factory.NewVaultAsync(_token, _userId);
        _docId = await _factory.NewDocumentAsync(_token, _vaultId);
        _owner = IndexerAppFactory.OwnerOf(_vaultId);
    }

    public Task DisposeAsync() => Task.CompletedTask;

    private async Task<JsonObject> ChangesAsync(string instance, long since = 0, int limit = 2000)
    {
        var resp = await _factory.ServiceClient().GetAsync($"/internal/indexer/changes?instance={instance}&since={since}&limit={limit}");
        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        return (await resp.Content.ReadFromJsonAsync<JsonObject>())!;
    }

    private static IEnumerable<JsonObject> Rows(JsonObject changes, string vaultId) =>
        changes["changes"]!.AsArray().Select(c => c!.AsObject()).Where(c => c["vaultId"]!.GetValue<string>() == vaultId);

    private async Task PushVaultOpAsync(params byte[] op)
    {
        await using HubConnection vault = await _factory.HubAsync("/hubs/vault", _token);
        await vault.InvokeAsync("JoinVault", _vaultId);
        await vault.InvokeAsync("PushVaultOperation", _vaultId, B64(op));
    }

    private async Task PushDocOpAsync(string docId, params byte[] op)
    {
        await using HubConnection sync = await _factory.HubAsync("/hubs/sync", _token);
        await sync.InvokeAsync("PushOperation", _vaultId, docId, "client-1", B64(op));
    }

    // ── Jeton de service ──────────────────────────────────────────────────────

    [Fact(DisplayName = "API interne — sans jeton : 401")]
    public async Task NoToken_Is401()
    {
        var resp = await _factory.ServiceClient(token: null).GetAsync("/internal/indexer/vaults?instance=idx-a");
        resp.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact(DisplayName = "API interne — mauvais jeton (ou jeton d'utilisateur) : 401")]
    public async Task WrongToken_Is401()
    {
        (await _factory.ServiceClient("pas-le-bon").GetAsync("/internal/indexer/vaults?instance=idx-a"))
            .StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await _factory.ServiceClient(_token).GetAsync("/internal/indexer/changes?instance=idx-a"))
            .StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact(DisplayName = "API interne — bon jeton : 200 ; instance inconnue : 400")]
    public async Task GoodToken_Is200()
    {
        (await _factory.ServiceClient().GetAsync("/internal/indexer/vaults?instance=idx-a"))
            .StatusCode.Should().Be(HttpStatusCode.OK);
        var unknown = await _factory.ServiceClient().GetAsync("/internal/indexer/vaults?instance=idx-z");
        unknown.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await unknown.Content.ReadFromJsonAsync<JsonObject>())!["error"]!["code"]!.GetValue<string>().Should().Be("unknown_instance");
    }

    [Fact(DisplayName = "API interne — un vault n'est liste que par son instance")]
    public async Task Vaults_ListedByOwnerOnly()
    {
        foreach (var instance in IndexerAppFactory.Instances)
        {
            var list = (await _factory.ServiceClient().GetFromJsonAsync<JsonObject>($"/internal/indexer/vaults?instance={instance.Name}"))!;
            bool listed = list["vaults"]!.AsArray().Any(v => v!["vaultId"]!.GetValue<string>() == _vaultId);
            listed.Should().Be(instance.Name == _owner, $"{instance.Name} {(listed ? "liste" : "ne liste pas")} le vault");
        }
    }

    // ── Flux ─────────────────────────────────────────────────────────────────

    [Fact(DisplayName = "Flux — arborescence et document modifies, une ligne par ressource, sequence croissante")]
    public async Task Feed_RecordsWrites_OneRowPerResource()
    {
        await PushVaultOpAsync(1, 2, 3);
        await PushDocOpAsync(_docId, 4, 5);

        JsonObject first = await ChangesAsync(_owner);
        var rows = Rows(first, _vaultId).ToList();
        rows.Should().ContainSingle(r => r["kind"]!.GetValue<string>() == "vault" && r["docId"] == null);
        JsonObject doc = rows.Single(r => r["kind"]!.GetValue<string>() == "document");
        doc["docId"]!.GetValue<string>().Should().Be(_docId);
        long docSeq = doc["seq"]!.GetValue<long>();
        long vaultSeq = rows.Single(r => r["kind"]!.GetValue<string>() == "vault")["seq"]!.GetValue<long>();
        docSeq.Should().BeGreaterThan(vaultSeq);
        first["last"]!.GetValue<long>().Should().BeGreaterThanOrEqualTo(docSeq);
        first["epoch"]!.GetValue<string>().Should().NotBeNullOrEmpty();
        first["changes"]!.AsArray().Select(c => c!["seq"]!.GetValue<long>()).Should().BeInAscendingOrder();

        // Deuxieme ecriture : la meme ligne passe en fin de flux.
        await PushDocOpAsync(_docId, 6);
        JsonObject second = await ChangesAsync(_owner);
        var docRows = Rows(second, _vaultId).Where(r => r["kind"]!.GetValue<string>() == "document").ToList();
        docRows.Should().ContainSingle();
        docRows[0]["seq"]!.GetValue<long>().Should().BeGreaterThan(docSeq);

        // Depuis l'ancienne sequence : seulement la nouvelle ligne du document.
        JsonObject since = await ChangesAsync(_owner, docSeq);
        Rows(since, _vaultId).Should().ContainSingle(r => r["docId"]!.GetValue<string>() == _docId);
        second["epoch"]!.GetValue<string>().Should().Be(first["epoch"]!.GetValue<string>());
    }

    [Fact(DisplayName = "Flux — les autres instances ne voient pas le vault, mais last avance pour elles aussi")]
    public async Task Feed_FilteredByInstance()
    {
        await PushDocOpAsync(_docId, 7);
        long head = (await ChangesAsync(_owner))["last"]!.GetValue<long>();

        foreach (var other in IndexerAppFactory.Instances.Where(i => i.Name != _owner))
        {
            JsonObject changes = await ChangesAsync(other.Name);
            Rows(changes, _vaultId).Should().BeEmpty();
            changes["last"]!.GetValue<long>().Should().BeGreaterThanOrEqualTo(head);
        }
    }

    [Fact(DisplayName = "Flux — compaction d'un document et room snapshot comptent comme des ecritures")]
    public async Task Feed_SnapshotsAndRooms()
    {
        await PushDocOpAsync(_docId, 8);
        long before = (await ChangesAsync(_owner))["last"]!.GetValue<long>();

        await using (HubConnection sync = await _factory.HubAsync("/hubs/sync", _token))
            await sync.InvokeAsync("SnapshotDocument", _vaultId, _docId, B64(9, 9));
        string tableId = await _factory.NewDocumentAsync(_token, _vaultId);
        await using (HubConnection room = await _factory.HubAsync("/hubs/room", _token))
            await room.InvokeAsync("PushSnapshot", _vaultId, tableId, """{"rows":[["a"]]}""");

        var rows = Rows(await ChangesAsync(_owner, before), _vaultId).ToList();
        rows.Should().Contain(r => r["docId"]!.GetValue<string>() == _docId);
        rows.Should().Contain(r => r["docId"]!.GetValue<string>() == tableId);

        // Le journal du document compacte ; la room rendue en JSON.
        var doc = (await _factory.ServiceClient().GetFromJsonAsync<JsonObject>($"/internal/indexer/vaults/{_vaultId}/documents/{_docId}"))!;
        doc["format"]!.GetValue<string>().Should().Be("yjs");
        doc["updates"]!.AsArray().Select(u => u!.GetValue<string>()).Should().Equal(B64(9, 9));
        var table = (await _factory.ServiceClient().GetFromJsonAsync<JsonObject>($"/internal/indexer/vaults/{_vaultId}/documents/{tableId}"))!;
        table["format"]!.GetValue<string>().Should().Be("json");
        Encoding.UTF8.GetString(Convert.FromBase64String(table["updates"]![0]!.GetValue<string>()))
            .Should().Be("""{"rows":[["a"]]}""");
    }

    // ── Journaux ─────────────────────────────────────────────────────────────

    [Fact(DisplayName = "Journaux — arborescence et document rendus en base64 ; document inconnu : 404")]
    public async Task Tree_And_Document()
    {
        await PushVaultOpAsync(0xA1, 0xA2);
        string docId = await _factory.NewDocumentAsync(_token, _vaultId);
        await PushDocOpAsync(docId, 0xB1);
        await PushDocOpAsync(docId, 0xB2);

        var tree = (await _factory.ServiceClient().GetFromJsonAsync<JsonObject>($"/internal/indexer/vaults/{_vaultId}/tree"))!;
        tree["updates"]!.AsArray().Select(u => u!.GetValue<string>()).Should().Contain(B64(0xA1, 0xA2));

        var doc = (await _factory.ServiceClient().GetFromJsonAsync<JsonObject>($"/internal/indexer/vaults/{_vaultId}/documents/{docId}"))!;
        doc["updates"]!.AsArray().Select(u => u!.GetValue<string>()).Should().Equal(B64(0xB1), B64(0xB2));

        (await _factory.ServiceClient().GetAsync($"/internal/indexer/vaults/{_vaultId}/documents/{Guid.NewGuid()}"))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await _factory.ServiceClient().GetAsync($"/internal/indexer/vaults/{Guid.NewGuid()}/tree"))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);

        // Un document d'un autre vault n'est pas rendu sous ce vault.
        string otherVault = await _factory.NewVaultAsync(_token, _userId, "Autre");
        (await _factory.ServiceClient().GetAsync($"/internal/indexer/vaults/{otherVault}/documents/{docId}"))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    // ── Perimetre du pair gere ───────────────────────────────────────────────

    [Fact(DisplayName = "Reglage none — vault-deleted dans le flux, plus liste ni lisible ; retour au pair gere : changement vault")]
    public async Task ModeNone_LeavesAndReturns()
    {
        string vaultId = await _factory.NewVaultAsync(_token, _userId, "Sans pair");
        string owner = IndexerAppFactory.OwnerOf(vaultId);
        HttpClient http = _factory.Client(_token);
        long before = (await ChangesAsync(owner))["last"]!.GetValue<long>();

        (await http.PutAsJsonAsync($"/api/v1/vaults/{vaultId}/indexer", new { mode = "none" })).EnsureSuccessStatusCode();

        var left = Rows(await ChangesAsync(owner, before), vaultId).ToList();
        left.Should().ContainSingle().Which["kind"]!.GetValue<string>().Should().Be("vault-deleted");
        var list = (await _factory.ServiceClient().GetFromJsonAsync<JsonObject>($"/internal/indexer/vaults?instance={owner}"))!;
        list["vaults"]!.AsArray().Should().NotContain(v => v!["vaultId"]!.GetValue<string>() == vaultId);
        (await _factory.ServiceClient().GetAsync($"/internal/indexer/vaults/{vaultId}/tree"))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);

        // Ecrire dans un vault hors du pair gere ne remonte pas dans le flux.
        long mid = (await ChangesAsync(owner))["last"]!.GetValue<long>();
        await using (HubConnection vault = await _factory.HubAsync("/hubs/vault", _token))
        {
            await vault.InvokeAsync("JoinVault", vaultId);
            await vault.InvokeAsync("PushVaultOperation", vaultId, B64(1));
        }
        Rows(await ChangesAsync(owner, mid), vaultId).Should().BeEmpty();

        (await http.PutAsJsonAsync($"/api/v1/vaults/{vaultId}/indexer", new { mode = "managed" })).EnsureSuccessStatusCode();
        Rows(await ChangesAsync(owner, mid), vaultId).Should().ContainSingle()
            .Which["kind"]!.GetValue<string>().Should().Be("vault");
    }

    [Fact(DisplayName = "Vault supprime — une ligne vault-deleted, plus aucune autre ligne pour lui")]
    public async Task DeletedVault()
    {
        string vaultId = await _factory.NewVaultAsync(_token, _userId, "A supprimer");
        string owner = IndexerAppFactory.OwnerOf(vaultId);
        string docId = await _factory.NewDocumentAsync(_token, vaultId);
        await using (HubConnection sync = await _factory.HubAsync("/hubs/sync", _token))
            await sync.InvokeAsync("PushOperation", vaultId, docId, "c", B64(1));
        Rows(await ChangesAsync(owner), vaultId).Should().NotBeEmpty();

        (await _factory.Client(_token).DeleteAsync($"/api/v1/vaults/{vaultId}")).StatusCode.Should().Be(HttpStatusCode.NoContent);

        var rows = Rows(await ChangesAsync(owner), vaultId).ToList();
        rows.Should().ContainSingle().Which["kind"]!.GetValue<string>().Should().Be("vault-deleted");
        (await _factory.ServiceClient().GetAsync($"/internal/indexer/vaults/{vaultId}/tree"))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
    }
}
