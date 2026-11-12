// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// API ouverte : jetons personnels, routes REST /api/open/v1 et serveur MCP
// /api/mcp, devant un faux pair indexeur.

using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;
using FluentAssertions;

namespace Savoire.Server.Integration.Tests.Indexer;

[Collection("Integration")]
public class OpenApiTests : IClassFixture<IndexerAppFactory>, IAsyncLifetime
{
    private readonly IndexerAppFactory _factory;
    private string _ownerToken = null!;
    private string _ownerId = null!;
    private string _vaultA = null!;
    private string _vaultB = null!;

    public OpenApiTests(IndexerAppFactory factory) => _factory = factory;

    public async Task InitializeAsync()
    {
        _factory.Peer.Reset();
        var uid = Guid.NewGuid().ToString("N")[..8];
        (_ownerToken, _ownerId) = await _factory.CreateUserAndGetTokenAsync($"open-owner-{uid}@test.com", displayName: "Owner");
        _vaultA = await _factory.NewVaultAsync(_ownerToken, _ownerId, "Notes A");
        _vaultB = await _factory.NewVaultAsync(_ownerToken, _ownerId, "Notes B");
    }

    public Task DisposeAsync() => Task.CompletedTask;

    private async Task<(string Token, string Id)> NewTokenAsync(object body)
    {
        var resp = await _factory.Client(_ownerToken).PostAsJsonAsync("/api/v1/me/access-tokens", body);
        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        JsonObject created = (await resp.Content.ReadFromJsonAsync<JsonObject>())!;
        return (created["token"]!.GetValue<string>(), created["info"]!["id"]!.GetValue<string>());
    }

    private static StringContent Json(string json) => new(json, Encoding.UTF8, "application/json");

    private async Task<JsonObject> McpAsync(string token, string json)
    {
        var resp = await _factory.Client(token).PostAsync("/api/mcp", Json(json));
        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        return (await resp.Content.ReadFromJsonAsync<JsonObject>())!;
    }

    [Fact(DisplayName = "Jeton — montre une fois, liste sans le jeton, lit les vaults ; refuse sur les routes de l'appli")]
    public async Task Token_Lifecycle()
    {
        (string token, string id) = await NewTokenAsync(new { name = "Claude" });
        token.Should().StartWith("svp_");

        JsonArray list = (await _factory.Client(_ownerToken).GetFromJsonAsync<JsonArray>("/api/v1/me/access-tokens"))!;
        JsonNode mine = list.Single(t => t!["id"]!.GetValue<string>() == id)!;
        mine["name"]!.GetValue<string>().Should().Be("Claude");
        mine.ToJsonString().Should().NotContain(token);

        JsonObject vaults = (await _factory.Client(token).GetFromJsonAsync<JsonObject>("/api/open/v1/vaults"))!;
        vaults["vaults"]!.AsArray().Select(v => v!["name"]!.GetValue<string>()).Should().Contain(["Notes A", "Notes B"]);

        // Un jeton personnel n'ouvre pas les routes de l'application.
        (await _factory.Client(token).GetAsync("/api/v1/me/access-tokens")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await _factory.Client(token).GetAsync($"/api/v1/users/{_ownerId}/vaults")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        // Revoque : plus rien.
        (await _factory.Client(_ownerToken).DeleteAsync($"/api/v1/me/access-tokens/{id}")).StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await _factory.Client(token).GetAsync("/api/open/v1/vaults")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await _factory.CreateClient().GetAsync("/api/open/v1/vaults")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact(DisplayName = "Jeton limite a un vault — l'autre est refuse (403), un vault d'autrui ne peut pas etre choisi")]
    public async Task Token_VaultScope()
    {
        (string token, _) = await NewTokenAsync(new { name = "n8n", vaultIds = new[] { _vaultA } });
        JsonObject vaults = (await _factory.Client(token).GetFromJsonAsync<JsonObject>("/api/open/v1/vaults"))!;
        vaults["vaults"]!.AsArray().Select(v => v!["id"]!.GetValue<string>()).Should().Equal(_vaultA);

        _factory.Peer.Reset(_ => FakeIndexerPeer.Json(HttpStatusCode.OK, """{"result":{"hits":[],"total":0}}"""));
        (await _factory.Client(token).PostAsync($"/api/open/v1/vaults/{_vaultA}/search", Json("""{"text":"plan"}""")))
            .StatusCode.Should().Be(HttpStatusCode.OK);
        var refused = await _factory.Client(token).PostAsync($"/api/open/v1/vaults/{_vaultB}/search", Json("""{"text":"plan"}"""));
        refused.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await refused.Content.ReadFromJsonAsync<JsonObject>())!["error"]!["code"]!.GetValue<string>().Should().Be("forbidden_vault");
        _factory.Peer.Requests.Should().ContainSingle();

        (await _factory.Client(_ownerToken).PostAsJsonAsync("/api/v1/me/access-tokens", new { name = "x", vaultIds = new[] { "pas-a-moi" } }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact(DisplayName = "REST — recherche et lecture relayees au pair, au nom de la personne")]
    public async Task Rest_SearchAndRead()
    {
        (string token, _) = await NewTokenAsync(new { name = "script" });
        _factory.Peer.Reset(r => r.Body!.Contains("\"documents\"")
            ? FakeIndexerPeer.Json(HttpStatusCode.OK, """{"result":{"id":"n1","path":"Plan.md","title":"Plan","content":"# Plan","truncated":false}}""")
            : FakeIndexerPeer.Json(HttpStatusCode.OK, """{"result":{"hits":[{"id":"n1","path":"Plan.md","title":"Plan"}],"total":1}}"""));

        var search = await _factory.Client(token).PostAsync($"/api/open/v1/vaults/{_vaultA}/search", Json("""{"text":"plan","limit":500}"""));
        search.StatusCode.Should().Be(HttpStatusCode.OK);
        (await search.Content.ReadFromJsonAsync<JsonObject>())!["total"]!.GetValue<int>().Should().Be(1);

        var read = await _factory.Client(token).GetAsync($"/api/open/v1/vaults/{_vaultA}/notes/read?path=Plan.md");
        (await read.Content.ReadFromJsonAsync<JsonObject>())!["content"]!.GetValue<string>().Should().Be("# Plan");

        PeerRequest[] seen = _factory.Peer.Requests.ToArray();
        JsonObject first = JsonNode.Parse(seen[0].Body!)!.AsObject();
        first["capability"]!.GetValue<string>().Should().Be("search");
        first["params"]!["limit"]!.GetValue<int>().Should().Be(50); // borne
        first["caller"]!["userId"]!.GetValue<string>().Should().Be(_ownerId);
        JsonObject second = JsonNode.Parse(seen[1].Body!)!.AsObject();
        second["capability"]!.GetValue<string>().Should().Be("documents");
        second["method"]!.GetValue<string>().Should().Be("read");
        second["params"]!["path"]!.GetValue<string>().Should().Be("Plan.md");
    }

    [Fact(DisplayName = "MCP — initialize, outils, recherche par nom de vault, notification 202, sans jeton 401")]
    public async Task Mcp()
    {
        (string token, _) = await NewTokenAsync(new { name = "Claude" });

        JsonObject init = await McpAsync(token, """{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}""");
        init["result"]!["protocolVersion"]!.GetValue<string>().Should().Be("2025-03-26");
        init["result"]!["serverInfo"]!["name"]!.GetValue<string>().Should().Be("savoire");

        (await _factory.Client(token).PostAsync("/api/mcp", Json("""{"jsonrpc":"2.0","method":"notifications/initialized"}""")))
            .StatusCode.Should().Be(HttpStatusCode.Accepted);

        JsonObject tools = await McpAsync(token, """{"jsonrpc":"2.0","id":2,"method":"tools/list"}""");
        tools["result"]!["tools"]!.AsArray().Select(t => t!["name"]!.GetValue<string>())
            .Should().BeEquivalentTo(["list_vaults", "search", "list_notes", "read_note"]);

        _factory.Peer.Reset(_ => FakeIndexerPeer.Json(HttpStatusCode.OK,
            """{"result":{"hits":[{"id":"n1","path":"Projets/Plan.md","title":"Plan","snippets":[{"text":"le plan de mars"}]}],"total":1}}"""));
        JsonObject call = await McpAsync(token, """{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search","arguments":{"vault":"notes a","query":"plan"}}}""");
        call["result"]!["isError"]!.GetValue<bool>().Should().BeFalse();
        string text = call["result"]!["content"]![0]!["text"]!.GetValue<string>();
        text.Should().Contain("Projets/Plan.md").And.Contain("le plan de mars");
        _factory.Peer.Requests.Single().Path.Should().Be($"/v1/vaults/{_vaultA}/call");

        JsonObject unknownVault = await McpAsync(token, """{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"search","arguments":{"vault":"inconnu","query":"x"}}}""");
        unknownVault["result"]!["isError"]!.GetValue<bool>().Should().BeTrue();

        JsonObject bad = await McpAsync(token, """{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"search","arguments":{"vault":"Notes A"}}}""");
        bad["error"]!["code"]!.GetValue<int>().Should().Be(-32602);

        (await _factory.CreateClient().PostAsync("/api/mcp", Json("""{"jsonrpc":"2.0","id":1,"method":"ping"}""")))
            .StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact(DisplayName = "Description OpenAPI — sans jeton, avec l'adresse du serveur")]
    public async Task OpenApiDescription()
    {
        var resp = await _factory.CreateClient().GetAsync("/api/open/v1/openapi.yaml");
        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        string yaml = await resp.Content.ReadAsStringAsync();
        yaml.Should().Contain("url: \"http://localhost/api/open/v1\"").And.Contain("operationId: searchNotes").And.NotContain("{{SERVER}}");
    }
}
