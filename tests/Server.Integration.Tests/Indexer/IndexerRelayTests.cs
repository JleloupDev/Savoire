// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Routes publiques du pair indexeur, devant un faux pair : relais, droits,
// erreurs du pair, reglage du vault, recherche globale.

using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;
using FluentAssertions;
using Savoire.Application.Common;

namespace Savoire.Server.Integration.Tests.Indexer;

[Collection("Integration")]
public class IndexerRelayTests : IClassFixture<IndexerAppFactory>, IAsyncLifetime
{
    private readonly IndexerAppFactory _factory;
    private string _ownerToken = null!;
    private string _ownerId = null!;
    private string _readerToken = null!;
    private string _intruderToken = null!;
    private string _vaultId = null!;

    public IndexerRelayTests(IndexerAppFactory factory) => _factory = factory;

    public async Task InitializeAsync()
    {
        _factory.Peer.Reset();
        var uid = Guid.NewGuid().ToString("N")[..8];
        (_ownerToken, _ownerId) = await _factory.CreateUserAndGetTokenAsync($"idx-owner-{uid}@test.com", displayName: "Owner");
        (_readerToken, string readerId) = await _factory.CreateUserAndGetTokenAsync($"idx-reader-{uid}@test.com", displayName: "Reader");
        (_intruderToken, _) = await _factory.CreateUserAndGetTokenAsync($"idx-intruder-{uid}@test.com", displayName: "Intruder");
        _vaultId = await _factory.NewVaultAsync(_ownerToken, _ownerId);
        (await _factory.Client(_ownerToken).PostAsJsonAsync($"/api/v1/vaults/{_vaultId}/members",
            new { userId = readerId, role = "viewer" })).EnsureSuccessStatusCode();
    }

    public Task DisposeAsync() => Task.CompletedTask;

    private string CallUrl(string capability = "links", string method = "backlinks") =>
        $"/api/v1/vaults/{_vaultId}/index/{capability}/{method}";

    private static async Task<string?> ErrorCode(HttpResponseMessage resp) =>
        (await resp.Content.ReadFromJsonAsync<JsonObject>())?["error"]?["code"]?.GetValue<string>();

    private static StringContent Body(string json) => new(json, Encoding.UTF8, "application/json");

    // ── Relais ───────────────────────────────────────────────────────────────

    [Fact(DisplayName = "Relais — l'instance proprietaire recoit l'appel avec le jeton de service et l'appelant ; reponse = result")]
    public async Task Owner_CallIsRelayed()
    {
        _factory.Peer.Reset(_ => FakeIndexerPeer.Json(HttpStatusCode.OK, """{"result":{"items":[{"id":"n2","count":1}]}}"""));

        var resp = await _factory.Client(_ownerToken).PostAsync(CallUrl(),
            Body("""{"id":"n1","caller":{"userId":"quelqu-un-d-autre"}}"""));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        (await resp.Content.ReadFromJsonAsync<JsonObject>())!["items"]![0]!["id"]!.GetValue<string>().Should().Be("n2");
        PeerRequest seen = _factory.Peer.Requests.Single();
        seen.Method.Should().Be("POST");
        seen.Instance.Should().Be(IndexerAppFactory.OwnerOf(_vaultId));
        seen.Path.Should().Be($"/v1/vaults/{_vaultId}/call");
        seen.Authorization.Should().Be($"Bearer {IndexerAppFactory.ServiceToken}");
        JsonObject body = JsonNode.Parse(seen.Body!)!.AsObject();
        body["capability"]!.GetValue<string>().Should().Be("links");
        body["method"]!.GetValue<string>().Should().Be("backlinks");
        body["params"]!["id"]!.GetValue<string>().Should().Be("n1");
        body["caller"]!["userId"]!.GetValue<string>().Should().Be(_ownerId);
    }

    [Fact(DisplayName = "Droits — un lecteur passe, un non-membre non (masque en 404), sans jeton 401")]
    public async Task Rights()
    {
        (await _factory.Client(_readerToken).PostAsync(CallUrl(), Body("{}"))).StatusCode.Should().Be(HttpStatusCode.OK);
        (await _factory.Client(_intruderToken).PostAsync(CallUrl(), Body("{}"))).StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await _factory.CreateClient().PostAsync(CallUrl(), Body("{}"))).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        // Le non-membre n'a rien atteint : seul l'appel du lecteur est parti.
        _factory.Peer.Requests.Should().ContainSingle();
    }

    [Fact(DisplayName = "Droits — un lien de partage du vault n'a acces a aucune route du pair")]
    public async Task ShareLink_IsRefused()
    {
        var link = await (await _factory.Client(_ownerToken).PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/sharing/links", new { permission = "read", expiresAt = (DateTime?)null }))
            .Content.ReadFromJsonAsync<ShareLinkDto>();
        var access = await (await _factory.CreateClient().GetAsync($"/api/v1/share/{link!.Token}/access"))
            .Content.ReadFromJsonAsync<ShareLinkAccessDto>();
        HttpClient viaLink = _factory.Client(access!.AccessToken);

        (await viaLink.PostAsync(CallUrl(), Body("{}"))).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await viaLink.PostAsync("/api/v1/search", Body("""{"text":"x"}"""))).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await viaLink.GetAsync($"/api/v1/vaults/{_vaultId}/indexer")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        _factory.Peer.Requests.Should().BeEmpty();
    }

    [Fact(DisplayName = "Erreurs du pair — 503 avec son Retry-After, 400 tel quel")]
    public async Task PeerErrors()
    {
        _factory.Peer.Reset(_ => FakeIndexerPeer.Json(HttpStatusCode.ServiceUnavailable,
            """{"error":{"code":"unavailable","message":"redemarrage"}}""", retryAfter: 9));
        var unavailable = await _factory.Client(_ownerToken).PostAsync(CallUrl(), Body("{}"));
        unavailable.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        unavailable.Headers.RetryAfter!.Delta.Should().Be(TimeSpan.FromSeconds(9));
        (await ErrorCode(unavailable)).Should().Be("unavailable");

        _factory.Peer.Reset(_ => FakeIndexerPeer.Json(HttpStatusCode.BadRequest,
            """{"error":{"code":"invalid_query","message":"champ inconnu"}}"""));
        var invalid = await _factory.Client(_ownerToken).PostAsync(CallUrl("query", "run"), Body("""{"where":{}}"""));
        invalid.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await ErrorCode(invalid)).Should().Be("invalid_query");
    }

    [Fact(DisplayName = "Pair injoignable — 503 + Retry-After")]
    public async Task PeerDown_Is503()
    {
        _factory.Peer.Reset(_ => throw new HttpRequestException("connection refused"));
        var resp = await _factory.Client(_ownerToken).PostAsync(CallUrl(), Body("{}"));
        resp.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        resp.Headers.RetryAfter!.Delta.Should().Be(TimeSpan.FromSeconds(5));
        (await ErrorCode(resp)).Should().Be("unavailable");
    }

    [Fact(DisplayName = "409 not_owner — un nouvel essai, puis la reponse")]
    public async Task NotOwner_Retries()
    {
        int calls = 0;
        _factory.Peer.Reset(_ => Interlocked.Increment(ref calls) == 1
            ? FakeIndexerPeer.Json(HttpStatusCode.Conflict, """{"error":{"code":"not_owner","message":""}}""")
            : FakeIndexerPeer.Json(HttpStatusCode.OK, """{"result":[]}"""));
        var resp = await _factory.Client(_ownerToken).PostAsync(CallUrl(), Body("{}"));
        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        _factory.Peer.Requests.Should().HaveCount(2);
    }

    [Fact(DisplayName = "Corps — plus de 64 Kio : 413 ; JSON invalide ou nom de pouvoir invalide : 400")]
    public async Task BodyChecks()
    {
        string big = $$"""{"text":"{{new string('x', 70 * 1024)}}"}""";
        var tooLarge = await _factory.Client(_ownerToken).PostAsync(CallUrl(), Body(big));
        tooLarge.StatusCode.Should().Be(HttpStatusCode.RequestEntityTooLarge);
        (await ErrorCode(tooLarge)).Should().Be("payload_too_large");

        (await _factory.Client(_ownerToken).PostAsync(CallUrl(), Body("{pas du json"))).StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await _factory.Client(_ownerToken).PostAsync(CallUrl("Links", "x"), Body("{}"))).StatusCode.Should().Be(HttpStatusCode.BadRequest);
        _factory.Peer.Requests.Should().BeEmpty();
    }

    // ── Reglage du vault ─────────────────────────────────────────────────────

    [Fact(DisplayName = "Reglage — lisible par les membres, avec l'etat de l'index rendu par le pair")]
    public async Task Setting_ReadableByMembers()
    {
        _factory.Peer.Reset(r => r.Method == "GET"
            ? FakeIndexerPeer.Json(HttpStatusCode.OK, """{"status":"building","progress":0.5,"seq":3,"docs":2}""")
            : FakeIndexerPeer.Json(HttpStatusCode.OK, """{"result":null}"""));

        var setting = await _factory.Client(_readerToken).GetFromJsonAsync<JsonObject>($"/api/v1/vaults/{_vaultId}/indexer");
        setting!["mode"]!.GetValue<string>().Should().Be("managed");
        setting["state"]!["status"]!.GetValue<string>().Should().Be("building");
        _factory.Peer.Requests.Single().Path.Should().Be($"/v1/vaults/{_vaultId}/status");

        (await _factory.Client(_intruderToken).GetAsync($"/api/v1/vaults/{_vaultId}/indexer")).StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact(DisplayName = "Reglage — modifiable par le proprietaire seul ; url obligatoire pour organization")]
    public async Task Setting_OwnerOnly()
    {
        string url = $"/api/v1/vaults/{_vaultId}/indexer";
        (await _factory.Client(_readerToken).PutAsJsonAsync(url, new { mode = "none" })).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await _factory.Client(_intruderToken).PutAsJsonAsync(url, new { mode = "none" })).StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await _factory.Client(_ownerToken).PutAsJsonAsync(url, new { mode = "organization" })).StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await _factory.Client(_ownerToken).PutAsJsonAsync(url, new { mode = "organization", url = "javascript:alert(1)" })).StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await _factory.Client(_ownerToken).PutAsJsonAsync(url, new { mode = "autre" })).StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await _factory.Client(_ownerToken).GetFromJsonAsync<JsonObject>(url))!["mode"]!.GetValue<string>().Should().Be("managed");
    }

    [Fact(DisplayName = "Reglage organization — le serveur ne relaie pas : 503 avec { mode, url }")]
    public async Task Organization_ReturnsUrl()
    {
        var put = await _factory.Client(_ownerToken).PutAsJsonAsync($"/api/v1/vaults/{_vaultId}/indexer",
            new { mode = "organization", url = "https://indexer.example.org" });
        put.StatusCode.Should().Be(HttpStatusCode.OK);

        var setting = await _factory.Client(_readerToken).GetFromJsonAsync<JsonObject>($"/api/v1/vaults/{_vaultId}/indexer");
        setting!["mode"]!.GetValue<string>().Should().Be("organization");
        setting["url"]!.GetValue<string>().Should().Be("https://indexer.example.org");

        var call = await _factory.Client(_readerToken).PostAsync(CallUrl(), Body("{}"));
        call.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        call.Headers.RetryAfter.Should().BeNull();
        JsonObject body = (await call.Content.ReadFromJsonAsync<JsonObject>())!;
        body["mode"]!.GetValue<string>().Should().Be("organization");
        body["url"]!.GetValue<string>().Should().Be("https://indexer.example.org");
        _factory.Peer.Requests.Should().BeEmpty();
    }

    [Fact(DisplayName = "Reglage none — 503 + Retry-After, aucun relais")]
    public async Task None_Is503()
    {
        (await _factory.Client(_ownerToken).PutAsJsonAsync($"/api/v1/vaults/{_vaultId}/indexer", new { mode = "none" }))
            .EnsureSuccessStatusCode();
        var call = await _factory.Client(_ownerToken).PostAsync(CallUrl(), Body("{}"));
        call.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        call.Headers.RetryAfter.Should().NotBeNull();
        (await call.Content.ReadFromJsonAsync<JsonObject>())!["mode"]!.GetValue<string>().Should().Be("none");
        _factory.Peer.Requests.Should().BeEmpty();
    }

    // ── Recherche globale ────────────────────────────────────────────────────

    [Fact(DisplayName = "Recherche globale — une instance en echec : partial, les autres repondent ; jamais les vaults d'autrui")]
    public async Task GlobalSearch_Partial()
    {
        // Des vaults sur au moins deux instances.
        var vaults = new List<string> { _vaultId };
        while (vaults.Select(IndexerAppFactory.OwnerOf).Distinct().Count() < 2)
            vaults.Add(await _factory.NewVaultAsync(_ownerToken, _ownerId, $"V{vaults.Count}"));
        string failing = IndexerAppFactory.OwnerOf(_vaultId);
        (string intruderToken, string intruderId) = await _factory.CreateUserAndGetTokenAsync(
            $"idx-other-{Guid.NewGuid():N}@test.com", displayName: "Other");
        string foreign = await _factory.NewVaultAsync(intruderToken, intruderId, "Pas a moi");

        _factory.Peer.Reset(r =>
        {
            if (r.Instance == failing) throw new HttpRequestException("down");
            JsonArray ids = JsonNode.Parse(r.Body!)!["vaultIds"]!.AsArray();
            var hits = new JsonArray(ids.Select(id => (JsonNode)new JsonObject
            {
                ["id"] = $"note-{id}", ["path"] = "n.md", ["title"] = "N", ["score"] = 1.0,
                ["snippets"] = new JsonArray(), ["vaultId"] = id!.GetValue<string>(),
            }).ToArray());
            return FakeIndexerPeer.Json(HttpStatusCode.OK, new JsonObject
            {
                ["hits"] = hits, ["total"] = ids.Count, ["index"] = new JsonObject { ["status"] = "ready" },
            }.ToJsonString());
        });

        var resp = await _factory.Client(_ownerToken).PostAsync("/api/v1/search", Body("""{"text":"note"}"""));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        JsonObject result = (await resp.Content.ReadFromJsonAsync<JsonObject>())!;
        result["partial"]!.GetValue<bool>().Should().BeTrue();
        var hitVaults = result["hits"]!.AsArray().Select(h => h!["vaultId"]!.GetValue<string>()).ToList();
        hitVaults.Should().BeEquivalentTo(vaults.Where(v => IndexerAppFactory.OwnerOf(v) != failing));
        _factory.Peer.Requests.Should().OnlyContain(r => r.Path == "/v1/search");
        _factory.Peer.Requests.SelectMany(r => r.Body is null ? [] : JsonNode.Parse(r.Body)!["vaultIds"]!.AsArray().Select(v => v!.GetValue<string>()))
            .Should().NotContain(foreign);
    }
}
