// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Paquets « agent » : un modele d'agent IA sans code (agent.json).
using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using FluentAssertions;
using SavoireStore.Publishing;

namespace SavoireStore.Tests;

public class AgentPackageTests : IClassFixture<StoreFactory>
{
    private readonly StoreFactory _f;
    public AgentPackageTests(StoreFactory f) => _f = f;

    private static string Uid() => Guid.NewGuid().ToString("N")[..8];

    private const string Correcteur = """{"instructions":"Tu corriges la note.","permissions":{"read":"direct","edit":"propose"},"budget":{"maxSteps":30}}""";

    private static Dictionary<string, string> Files(string id, string agent, string extra = "") => new()
    {
        ["manifest.json"] = $$"""{"id":"{{id}}","kind":"agent","name":"Correcteur {{id}}","version":"1.0.0","description":"Corrige une note.","author":"Ada","license":"MIT"{{extra}}}""",
        ["agent.json"] = agent,
    };

    [Fact(DisplayName = "Paquet agent : relu, au catalogue, agent.json dans le paquet signe")]
    public async Task Agent_PublishedAndDownloaded()
    {
        string id = "correcteur-" + Uid(), repo = "ada/" + id;
        _f.GitHub.Release(repo, "1.0.0", Files(id, Correcteur));
        var resp = await _f.As("pub-" + Uid(), "Ada").PostAsJsonAsync("/api/v1/publish", new { repo });
        resp.StatusCode.Should().Be(HttpStatusCode.OK, await resp.Content.ReadAsStringAsync());
        JsonArray queue = (await _f.As(StoreFactory.AdminSubject).GetFromJsonAsync<JsonArray>("/api/v1/admin/queue"))!;
        string versionId = queue.Single(q => q!["itemId"]!.GetValue<string>() == id)!["versionId"]!.GetValue<string>();
        (await _f.As(StoreFactory.AdminSubject).PostAsync($"/api/v1/admin/versions/{versionId}/approve", null)).StatusCode.Should().Be(HttpStatusCode.NoContent);

        JsonObject page = (await _f.CreateClient().GetFromJsonAsync<JsonObject>($"/api/v1/items?kind=agent&q={id}"))!;
        page["items"]!.AsArray().Single()!["kind"]!.GetValue<string>().Should().Be("agent");
        var download = await _f.CreateClient().GetAsync($"/api/v1/items/{id}/download");
        download.StatusCode.Should().Be(HttpStatusCode.OK);
        download.Headers.Contains("X-Savoire-Signature").Should().BeTrue();
        JsonNode pkg = (await download.Content.ReadFromJsonAsync<JsonNode>())!;
        pkg["kind"]!.GetValue<string>().Should().Be("agent");
        pkg["files"]!["agent.json"]!.GetValue<string>().Should().Contain("\"edit\":\"propose\"");
    }

    [Fact(DisplayName = "Paquet agent : refuse sans agent.json, avec des droits de plugin, ou avec des droits invalides")]
    public async Task Agent_Rejected()
    {
        async Task<string> Reject(Dictionary<string, string> files)
        {
            string repo = "ada/r-" + Uid();
            _f.GitHub.Release(repo, "1.0.0", files);
            var resp = await _f.As("pub-" + Uid()).PostAsJsonAsync("/api/v1/publish", new { repo });
            resp.StatusCode.Should().Be((HttpStatusCode)422);
            return await resp.Content.ReadAsStringAsync();
        }
        var noAgent = Files("a-" + Uid(), Correcteur);
        noAgent.Remove("agent.json");
        (await Reject(noAgent)).Should().Contain("agent.json");
        (await Reject(Files("a-" + Uid(), Correcteur, ",\"permissions\":[\"vault:read\"]"))).Should().Contain("aucun droit de plugin");
        (await Reject(Files("a-" + Uid(), """{"instructions":"x","permissions":{"create":"propose"}}"""))).Should().Contain("« create »");
    }

    [Theory(DisplayName = "Controles d'agent.json")]
    [InlineData("""{"instructions":"x","permissions":{"read":"direct"}}""", null, null)]
    [InlineData("""{"permissions":{"read":"direct"}}""", "error", "instructions")]
    [InlineData("""{"instructions":"x"}""", "error", "permissions")]
    [InlineData("""{"instructions":"x","permissions":{"fly":"direct"}}""", "error", "action inconnue")]
    [InlineData("""{"instructions":"x","permissions":{"delete":"direct"}}""", "warning", "en direct")]
    [InlineData("""[1]""", "error", "objet JSON")]
    [InlineData("""{"instructions":"x","permissions":{"read":"ask"}}""", "error", "« read »")]
    [InlineData("""{"instructions":"x","permissions":{"delegate":"propose"}}""", "error", "« delegate »")]
    [InlineData("""{"instructions":"x","permissions":{"read":"direct"},"budget":{"maxSteps":0}}""", "error", "budget.maxSteps")]
    [InlineData("""{"instructions":"x","permissions":{"read":"direct"},"budget":{"coffee":1}}""", "error", "budget inconnu")]
    [InlineData("""{"instructions":"x","permissions":{"read":"direct"},"vaultScoped":"oui"}""", "error", "vaultScoped")]
    [InlineData("""{"instructions":"x","permissions":{"read":"direct"},"budget":{"maxSteps":20},"vaultScoped":true}""", null, null)]
    public void Checks(string json, string? level, string? message)
    {
        List<Check> checks = AgentPreset.Check(json);
        if (level is null) { checks.Should().BeEmpty(); return; }
        checks.Should().Contain(c => c.Level == level && c.Message.Contains(message!));
    }

    [Fact(DisplayName = "Instructions trop longues refusees")]
    public void Checks_TooLongInstructions()
    {
        string json = "{\"instructions\":\"" + new string('a', AgentPreset.MaxInstructions + 1) + "\",\"permissions\":{\"read\":\"direct\"}}";
        AgentPreset.Check(json).Should().Contain(c => c.Level == "error" && c.Message.Contains("instructions"));
    }

    [Fact(DisplayName = "Page du paquet agent : droits en clair")]
    public async Task Agent_PageShowsRights()
    {
        string id = "lecteur-" + Uid(), repo = "ada/" + id;
        _f.GitHub.Release(repo, "1.0.0", Files(id, Correcteur));
        (await _f.As("pub-" + Uid(), "Ada").PostAsJsonAsync("/api/v1/publish", new { repo })).StatusCode.Should().Be(HttpStatusCode.OK);
        JsonArray queue = (await _f.As(StoreFactory.AdminSubject).GetFromJsonAsync<JsonArray>("/api/v1/admin/queue"))!;
        string versionId = queue.Single(q => q!["itemId"]!.GetValue<string>() == id)!["versionId"]!.GetValue<string>();
        await _f.As(StoreFactory.AdminSubject).PostAsync($"/api/v1/admin/versions/{versionId}/approve", null);

        JsonObject detail = (await _f.CreateClient().GetFromJsonAsync<JsonObject>($"/api/v1/items/{id}"))!;
        detail["agent"]!["rights"]!.AsArray().Should().HaveCount(2);
        detail["agent"]!["budget"]!["maxSteps"]!.GetValue<int>().Should().Be(30);
    }
}
