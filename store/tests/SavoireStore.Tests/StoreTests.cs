// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using System.Net;
using Microsoft.AspNetCore.Hosting;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using FluentAssertions;

namespace SavoireStore.Tests;

public class StoreTests : IClassFixture<StoreFactory>
{
    private readonly StoreFactory _f;
    public StoreTests(StoreFactory f) => _f = f;

    private static string Uid() => Guid.NewGuid().ToString("N")[..8];

    private static Dictionary<string, string> PluginFiles(string id, string version, string code = "module.exports = { onload() {} }", string extra = "")
        => new()
        {
            ["manifest.json"] = $$"""{"id":"{{id}}","name":"Kanban {{id}}","version":"{{version}}","description":"Des tableaux kanban.","author":"Ada","license":"MIT","permissions":["vault:read"],"categories":["Organisation"]{{extra}}}""",
            ["main.js"] = code,
        };

    private async Task<HttpResponseMessage> PublishAsync(HttpClient client, string repo) =>
        await client.PostAsJsonAsync("/api/v1/publish", new { repo });

    /// <summary>Publie et fait approuver la premiere version : l'element est au catalogue.</summary>
    private async Task<(string Id, string Repo, string Publisher)> ListedAsync(string version = "1.0.0")
    {
        string id = "kanban-" + Uid(), repo = "ada/" + id, publisher = "pub-" + Uid();
        _f.GitHub.Release(repo, version, PluginFiles(id, version));
        (await PublishAsync(_f.As(publisher, "Ada"), repo)).StatusCode.Should().Be(HttpStatusCode.OK);
        JsonArray queue = (await _f.As(StoreFactory.AdminSubject).GetFromJsonAsync<JsonArray>("/api/v1/admin/queue"))!;
        string versionId = queue.Single(q => q!["itemId"]!.GetValue<string>() == id)!["versionId"]!.GetValue<string>();
        (await _f.As(StoreFactory.AdminSubject).PostAsJsonAsync($"/api/v1/admin/versions/{versionId}/approve", new { note = "ok" }))
            .StatusCode.Should().Be(HttpStatusCode.NoContent);
        return (id, repo, publisher);
    }

    [Fact(DisplayName = "Premiere version : en attente, relue, puis au catalogue avec un paquet signe")]
    public async Task FirstVersion_ReviewThenListed()
    {
        string id = "kanban-" + Uid(), repo = "ada/" + id, publisher = "pub-" + Uid();
        _f.GitHub.Release(repo, "v1.0.0", PluginFiles(id, "1.0.0"));

        var resp = await PublishAsync(_f.As(publisher, "Ada"), repo);
        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        (await resp.Content.ReadFromJsonAsync<JsonObject>())!["status"]!.GetValue<string>().Should().Be("pending");
        (await _f.CreateClient().GetAsync($"/api/v1/items/{id}")).StatusCode.Should().Be(HttpStatusCode.NotFound);

        // Pas administrateur : pas de file d'attente.
        (await _f.As(publisher).GetAsync("/api/v1/admin/queue")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        JsonArray queue = (await _f.As(StoreFactory.AdminSubject).GetFromJsonAsync<JsonArray>("/api/v1/admin/queue"))!;
        JsonNode entry = queue.Single(q => q!["itemId"]!.GetValue<string>() == id)!;
        entry["firstVersion"]!.GetValue<bool>().Should().BeTrue();
        (await _f.As(StoreFactory.AdminSubject).PostAsync($"/api/v1/admin/versions/{entry["versionId"]}/approve", null))
            .StatusCode.Should().Be(HttpStatusCode.NoContent);

        JsonObject detail = (await _f.CreateClient().GetFromJsonAsync<JsonObject>($"/api/v1/items/{id}"))!;
        detail["item"]!["latestVersion"]!.GetValue<string>().Should().Be("1.0.0");
        detail["item"]!["author"]!.GetValue<string>().Should().Be("Ada");
        detail["permissions"]!.AsArray().Select(p => p!.GetValue<string>()).Should().Equal("vault:read");
        JsonObject page = (await _f.CreateClient().GetFromJsonAsync<JsonObject>($"/api/v1/items?q={id}"))!;
        page["total"]!.GetValue<int>().Should().Be(1);

        // Le paquet et sa signature, verifiee avec la cle publique du store.
        var download = await _f.CreateClient().GetAsync($"/api/v1/items/{id}/download");
        download.StatusCode.Should().Be(HttpStatusCode.OK);
        byte[] package = await download.Content.ReadAsByteArrayAsync();
        string signature = download.Headers.GetValues("X-Savoire-Signature").Single();
        JsonObject key = (await _f.CreateClient().GetFromJsonAsync<JsonObject>("/api/v1/signing-key"))!;
        using var ecdsa = ECDsa.Create();
        ecdsa.ImportSubjectPublicKeyInfo(Convert.FromBase64String(key["spki"]!.GetValue<string>()), out _);
        ecdsa.VerifyData(package, Convert.FromBase64String(signature), HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation)
            .Should().BeTrue();
        JsonNode pkg = JsonNode.Parse(package)!;
        pkg["files"]!["main.js"]!.GetValue<string>().Should().Contain("onload");
        pkg["manifest"]!["id"]!.GetValue<string>().Should().Be(id);
        (await _f.CreateClient().GetFromJsonAsync<JsonObject>($"/api/v1/items/{id}"))!["item"]!["downloads"]!.GetValue<long>().Should().Be(1);
    }

    [Fact(DisplayName = "Versions suivantes : publiees seules si tout passe ; un avertissement attend la relecture")]
    public async Task NextVersions()
    {
        (string id, string repo, string publisher) = await ListedAsync();

        _f.GitHub.Release(repo, "1.1.0", PluginFiles(id, "1.1.0"));
        var ok = await PublishAsync(_f.As(publisher), repo);
        (await ok.Content.ReadFromJsonAsync<JsonObject>())!["status"]!.GetValue<string>().Should().Be("published");
        (await _f.CreateClient().GetFromJsonAsync<JsonObject>($"/api/v1/items/{id}"))!["item"]!["latestVersion"]!.GetValue<string>().Should().Be("1.1.0");

        _f.GitHub.Release(repo, "1.2.0", PluginFiles(id, "1.2.0", "module.exports = { onload() { eval('1') } }"));
        var warned = await PublishAsync(_f.As(publisher), repo);
        JsonObject r = (await warned.Content.ReadFromJsonAsync<JsonObject>())!;
        r["status"]!.GetValue<string>().Should().Be("pending");
        r["checks"]!.AsArray().Should().Contain(c => c!["level"]!.GetValue<string>() == "warning");
        (await _f.CreateClient().GetFromJsonAsync<JsonObject>($"/api/v1/items/{id}"))!["item"]!["latestVersion"]!.GetValue<string>().Should().Be("1.1.0");

        // Meme version deux fois : refus.
        (await PublishAsync(_f.As(publisher), repo)).StatusCode.Should().Be(HttpStatusCode.Conflict);

        // Mes elements : les trois versions et leur etat.
        JsonArray mine = (await _f.As(publisher).GetFromJsonAsync<JsonArray>("/api/v1/me/items"))!;
        mine.Single()!["versions"]!.AsArray().Select(v => v!["status"]!.GetValue<string>()).Should().Equal("pending", "published", "published");
    }

    [Fact(DisplayName = "Controles : bibliotheque non commune, version differente de la release, droit inconnu, official")]
    public async Task Checks_Reject()
    {
        string id = "bad-" + Uid(), repo = "bob/" + id;
        _f.GitHub.Release(repo, "2.0.0", PluginFiles(id, "1.0.0", "const _ = require('lodash')", ""","official":true"""));
        var resp = await PublishAsync(_f.As("pub-" + Uid()), repo);
        resp.StatusCode.Should().Be((HttpStatusCode)422);
        string[] messages = (await resp.Content.ReadFromJsonAsync<JsonObject>())!["result"]!["checks"]!.AsArray()
            .Where(c => c!["level"]!.GetValue<string>() == "error").Select(c => c!["message"]!.GetValue<string>()).ToArray();
        messages.Should().Contain(m => m.Contains("lodash")).And.Contain(m => m.Contains("2.0.0")).And.Contain(m => m.Contains("official"));

        _f.GitHub.Release("bob/nothing", "1.0.0", new Dictionary<string, string> { ["main.js"] = "" });
        (await PublishAsync(_f.As("pub-" + Uid()), "bob/nothing")).StatusCode.Should().Be((HttpStatusCode)422);
        (await PublishAsync(_f.As("pub-" + Uid()), "bob/absent")).StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await PublishAsync(_f.As("pub-" + Uid()), "pas un depot")).StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await _f.CreateClient().PostAsJsonAsync("/api/v1/publish", new { repo })).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact(DisplayName = "Un id appartient a son editeur ; un refus a la relecture retire l'element")]
    public async Task Ownership_AndReject()
    {
        (string id, _, _) = await ListedAsync();
        string thief = "thief/" + id;
        _f.GitHub.Release(thief, "9.0.0", PluginFiles(id, "9.0.0"));
        (await PublishAsync(_f.As("pub-" + Uid()), thief)).StatusCode.Should().Be(HttpStatusCode.Forbidden);

        string other = "new-" + Uid();
        _f.GitHub.Release("eve/" + other, "1.0.0", PluginFiles(other, "1.0.0"));
        await PublishAsync(_f.As("pub-" + Uid()), "eve/" + other);
        JsonArray queue = (await _f.As(StoreFactory.AdminSubject).GetFromJsonAsync<JsonArray>("/api/v1/admin/queue"))!;
        string vid = queue.Single(q => q!["itemId"]!.GetValue<string>() == other)!["versionId"]!.GetValue<string>();
        (await _f.As(StoreFactory.AdminSubject).PostAsJsonAsync($"/api/v1/admin/versions/{vid}/reject", new { reason = "" }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await _f.As(StoreFactory.AdminSubject).PostAsJsonAsync($"/api/v1/admin/versions/{vid}/reject", new { reason = "Droits trop larges." }))
            .StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await _f.CreateClient().GetAsync($"/api/v1/items/{other}")).StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact(DisplayName = "Avis : un par compte et par version majeure, pas sur son propre element, reponse de l'editeur")]
    public async Task Reviews()
    {
        (string id, _, string publisher) = await ListedAsync();
        string reader = "reader-" + Uid();

        (await _f.CreateClient().PostAsJsonAsync($"/api/v1/items/{id}/reviews", new { rating = 5 })).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await _f.As(reader).PostAsJsonAsync($"/api/v1/items/{id}/reviews", new { rating = 6 })).StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await _f.As(publisher).PostAsJsonAsync($"/api/v1/items/{id}/reviews", new { rating = 5 })).StatusCode.Should().Be(HttpStatusCode.Forbidden);

        (await _f.As(reader, "Lou").PostAsJsonAsync($"/api/v1/items/{id}/reviews", new { rating = 5, text = "Parfait" })).EnsureSuccessStatusCode();
        var updated = await _f.As(reader, "Lou").PostAsJsonAsync($"/api/v1/items/{id}/reviews", new { rating = 3, text = "Bien <b>mais</b> lent" });
        string reviewId = (await updated.Content.ReadFromJsonAsync<JsonObject>())!["id"]!.GetValue<string>();
        (await _f.As("other-" + Uid()).PostAsJsonAsync($"/api/v1/items/{id}/reviews", new { rating = 5 })).EnsureSuccessStatusCode();

        JsonObject list = (await _f.CreateClient().GetFromJsonAsync<JsonObject>($"/api/v1/items/{id}/reviews"))!;
        list["count"]!.GetValue<int>().Should().Be(2);
        list["rating"]!.GetValue<double>().Should().Be(4.0);

        (await _f.As(reader).PostAsJsonAsync($"/api/v1/items/{id}/reviews/{reviewId}/reply", new { text = "x" })).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await _f.As(publisher).PostAsJsonAsync($"/api/v1/items/{id}/reviews/{reviewId}/reply", new { text = "Corrige en 1.0.1" })).StatusCode.Should().Be(HttpStatusCode.NoContent);

        // Le site : l'element, ses droits en clair, l'avis echappe, la reponse ; sans script.
        var html = await _f.CreateClient().GetAsync($"/items/{id}");
        html.Headers.GetValues("Content-Security-Policy").Single().Should().Contain("default-src 'none'");
        string body = await html.Content.ReadAsStringAsync();
        body.Should().Contain($"Kanban {id}").And.Contain("Lire les notes du vault").And.Contain("Bien &lt;b&gt;mais&lt;/b&gt; lent")
            .And.Contain("Corrige en 1.0.1").And.NotContain("<script");
        (await _f.CreateClient().GetStringAsync($"/?q={id}")).Should().Contain($"/items/{id}");
        (await _f.CreateClient().GetAsync("/items/absent")).StatusCode.Should().Be(HttpStatusCode.NotFound);

        (await _f.As("other-" + Uid()).DeleteAsync($"/api/v1/items/{id}/reviews/{reviewId}")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await _f.As(reader).DeleteAsync($"/api/v1/items/{id}/reviews/{reviewId}")).StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await _f.CreateClient().GetFromJsonAsync<JsonObject>($"/api/v1/items/{id}/reviews"))!["rating"]!.GetValue<double>().Should().Be(5.0);
    }

    // Change le 17/11/2026 (decision : les plugins du store tournent dans la
    // page, comme dans Obsidian) : avant, toute bibliotheque etait refusee.
    [Fact(DisplayName = "Plugin du store : seules les bibliotheques de Savoire, et aucune pour un plugin « frame »")]
    public async Task Plugin_LibrariesRefused()
    {
        string id = "lib-" + Uid(), repo = "ada/" + id;
        _f.GitHub.Release(repo, "1.0.0", PluginFiles(id, "1.0.0", code: "const _ = require('lodash'); module.exports = { onload() {} }"));
        var resp = await PublishAsync(_f.As("pub-" + Uid()), repo);
        resp.StatusCode.Should().Be((HttpStatusCode)422);
        (await resp.Content.ReadAsStringAsync()).Should().Contain("lodash");

        string id2 = "lib-" + Uid(), repo2 = "ada/" + id2;
        _f.GitHub.Release(repo2, "1.0.0", PluginFiles(id2, "1.0.0", extra: ",\"libraries\":[\"react\"],\"runtime\":\"frame\""));
        (await PublishAsync(_f.As("pub-" + Uid()), repo2)).StatusCode.Should().Be((HttpStatusCode)422);

        string id3 = "lib-" + Uid(), repo3 = "ada/" + id3;
        _f.GitHub.Release(repo3, "1.0.0", PluginFiles(id3, "1.0.0", code: "const React = require('react'); module.exports = { onload() {} }", extra: ",\"libraries\":[\"react\"]"));
        var ok = await PublishAsync(_f.As("pub-" + Uid()), repo3);
        ok.IsSuccessStatusCode.Should().BeTrue(await ok.Content.ReadAsStringAsync());
    }

    [Fact(DisplayName = "Plugin du store : capacites annoncees controlees a la publication")]
    public async Task Plugin_CapabilitiesChecked()
    {
        string id = "cap-" + Uid(), repo = "ada/" + id;
        _f.GitHub.Release(repo, "1.0.0", PluginFiles(id, "1.0.0", extra: ",\"capabilities\":[\"search\",\"teleportation\"]"));
        var resp = await PublishAsync(_f.As("pub-" + Uid()), repo);
        resp.StatusCode.Should().Be((HttpStatusCode)422);
        (await resp.Content.ReadAsStringAsync()).Should().Contain("teleportation");

        string id2 = "cap-" + Uid(), repo2 = "ada/" + id2;
        _f.GitHub.Release(repo2, "1.0.0", PluginFiles(id2, "1.0.0", extra: ",\"capabilities\":[\"search\",\"revision\"]"));
        var ok = await PublishAsync(_f.As("pub-" + Uid()), repo2);
        ok.IsSuccessStatusCode.Should().BeTrue(await ok.Content.ReadAsStringAsync());
    }

    [Fact(DisplayName = "L'application Savoire lit le catalogue depuis son domaine (CORS), avec les en-tetes de signature")]
    public async Task Cors_AppOriginOnly()
    {
        (string id, _, _) = await ListedAsync();
        var req = new HttpRequestMessage(HttpMethod.Get, $"/api/v1/items/{id}/download");
        req.Headers.Add("Origin", StoreFactory.AppOrigin);
        var resp = await _f.CreateClient().SendAsync(req);
        resp.Headers.GetValues("Access-Control-Allow-Origin").Single().Should().Be(StoreFactory.AppOrigin);
        string.Join(",", resp.Headers.GetValues("Access-Control-Expose-Headers")).Should().Contain("X-Savoire-Signature");

        var other = new HttpRequestMessage(HttpMethod.Get, "/api/v1/items");
        other.Headers.Add("Origin", "https://ailleurs.example");
        (await _f.CreateClient().SendAsync(other)).Headers.Contains("Access-Control-Allow-Origin").Should().BeFalse();
    }

    [Fact(DisplayName = "Sous l'adresse de Savoire (/store) : le site et l'API repondent, les liens gardent le prefixe")]
    public async Task PathBase_Store()
    {
        (string id, _, _) = await ListedAsync();
        using var under = _f.WithWebHostBuilder(b => b.UseSetting("Store:PathBase", "/store"));
        HttpClient client = under.CreateClient();
        string html = await client.GetStringAsync("/store/");
        html.Should().Contain($"href=\"/store/items/{id}\"").And.Contain("action=\"/store/\"");
        (await client.GetAsync($"/store/items/{id}")).StatusCode.Should().Be(HttpStatusCode.OK);
        (await client.GetAsync($"/store/api/v1/items/{id}")).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact(DisplayName = "Cle de signature donnee dans la configuration (PEM ou base64 d'un PEM)")]
    public void SigningKey_FromConfig()
    {
        using var ecdsa = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        string pem = ecdsa.ExportPkcs8PrivateKeyPem();
        byte[] data = "paquet"u8.ToArray();
        foreach (string value in new[] { pem, Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(pem)) })
        {
            using var signer = SavoireStore.Signing.PackageSigner.FromPem(value);
            ecdsa.VerifyData(data, Convert.FromBase64String(signer.Sign(data)), HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation)
                .Should().BeTrue();
        }
    }
}
