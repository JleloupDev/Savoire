// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Paquets de notes : notes.zip dans la release, notes rangees sous « notes/ »
// dans le paquet signe.
using System.IO.Compression;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;
using FluentAssertions;
using SavoireStore.Publishing;

namespace SavoireStore.Tests;

public class NotesPackageTests : IClassFixture<StoreFactory>
{
    private readonly StoreFactory _f;
    public NotesPackageTests(StoreFactory f) => _f = f;

    private static string Uid() => Guid.NewGuid().ToString("N")[..8];

    private static byte[] Zip(params (string Path, byte[] Bytes)[] entries)
    {
        using var ms = new MemoryStream();
        using (var zip = new ZipArchive(ms, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach ((string path, byte[] bytes) in entries)
            {
                using Stream s = zip.CreateEntry(path).Open();
                s.Write(bytes);
            }
        }
        return ms.ToArray();
    }

    private static (string, byte[]) Note(string path, string text) => (path, Encoding.UTF8.GetBytes(text));

    private static Dictionary<string, string> Manifest(string id, string extra = "") => new()
    {
        ["manifest.json"] = $$"""{"id":"{{id}}","kind":"notes","name":"Bible {{id}}","version":"1.0.0","description":"Une Bible en notes.","author":"Ada","license":"CC0-1.0"{{extra}}}""",
    };

    [Fact(DisplayName = "Paquet de notes : relu, au catalogue, notes dans le paquet signe (compresse)")]
    public async Task Notes_PublishedAndDownloaded()
    {
        string id = "bible-" + Uid(), repo = "ada/" + id, publisher = "pub-" + Uid();
        _f.GitHub.Release(repo, "1.0.0", Manifest(id), new()
        {
            ["notes.zip"] = Zip(Note("Bible/Bible.md", "---\nbible: x\n---\n"), Note("Bible/01 - Genèse/Genèse 1.md", "*Au début.*\n*Genèse 1 : 1*^1\n"), ("Bible/", [])),
        });
        var resp = await _f.As(publisher, "Ada").PostAsJsonAsync("/api/v1/publish", new { repo });
        resp.StatusCode.Should().Be(HttpStatusCode.OK, await resp.Content.ReadAsStringAsync());
        JsonArray queue = (await _f.As(StoreFactory.AdminSubject).GetFromJsonAsync<JsonArray>("/api/v1/admin/queue"))!;
        string versionId = queue.Single(q => q!["itemId"]!.GetValue<string>() == id)!["versionId"]!.GetValue<string>();
        (await _f.As(StoreFactory.AdminSubject).PostAsync($"/api/v1/admin/versions/{versionId}/approve", null)).StatusCode.Should().Be(HttpStatusCode.NoContent);

        JsonObject page = (await _f.CreateClient().GetFromJsonAsync<JsonObject>($"/api/v1/items?kind=notes&q={id}"))!;
        page["items"]!.AsArray().Single()!["kind"]!.GetValue<string>().Should().Be("notes");

        var req = new HttpRequestMessage(HttpMethod.Get, $"/api/v1/items/{id}/download");
        req.Headers.AcceptEncoding.ParseAdd("gzip");
        var download = await _f.CreateClient().SendAsync(req);
        download.StatusCode.Should().Be(HttpStatusCode.OK);
        download.Content.Headers.ContentEncoding.Should().Contain("gzip");
        await using var gz = new GZipStream(await download.Content.ReadAsStreamAsync(), CompressionMode.Decompress);
        JsonNode pkg = (await JsonNode.ParseAsync(gz))!;
        pkg["kind"]!.GetValue<string>().Should().Be("notes");
        JsonObject files = pkg["files"]!.AsObject();
        files.Select(f => f.Key).Should().BeEquivalentTo("notes/Bible/Bible.md", "notes/Bible/01 - Genèse/Genèse 1.md");
        files["notes/Bible/01 - Genèse/Genèse 1.md"]!.GetValue<string>().Should().Contain("^1");
    }

    [Fact(DisplayName = "Paquet de notes : refuse sans notes.zip, avec des droits, ou avec un chemin dangereux")]
    public async Task Notes_Rejected()
    {
        async Task<string> Reject(Dictionary<string, string> files, Dictionary<string, byte[]>? binary)
        {
            string repo = "ada/r-" + Uid();
            _f.GitHub.Release(repo, "1.0.0", files, binary);
            var resp = await _f.As("pub-" + Uid()).PostAsJsonAsync("/api/v1/publish", new { repo });
            resp.StatusCode.Should().Be((HttpStatusCode)422);
            return await resp.Content.ReadAsStringAsync();
        }
        (await Reject(Manifest("n-" + Uid()), null)).Should().Contain("notes.zip");
        (await Reject(Manifest("n-" + Uid(), ",\"permissions\":[\"vault:read\"]"), new() { ["notes.zip"] = Zip(Note("a.md", "x")) }))
            .Should().Contain("aucun droit");
        (await Reject(Manifest("n-" + Uid()), new() { ["notes.zip"] = Zip(Note("../evil.md", "x")) })).Should().Contain("chemin invalide");
        (await Reject(Manifest("n-" + Uid()), new() { ["notes.zip"] = [1, 2, 3] })).Should().Contain("archive zip");
    }

    [Theory(DisplayName = "Chemins d'un paquet de notes")]
    [InlineData("Bible/Genèse 1.md", null)]
    [InlineData("notes.txt", null)]
    [InlineData("/etc/passwd.md", "chemin absolu")]
    [InlineData("C:/x.md", "chemin absolu")]
    [InlineData("a/../b.md", "chemin invalide")]
    [InlineData("a//b.md", "chemin invalide")]
    [InlineData(".obsidian/app.md", "fichier ou dossier cache")]
    [InlineData("a/script.js", "extension non prise en charge (.js)")]
    [InlineData("a/b", "extension non prise en charge (aucune)")]
    [InlineData("a?.md", "caractere interdit dans le chemin")]
    public void PathProblems(string path, string? problem) => NotesArchive.PathProblem(path).Should().Be(problem);

    [Fact(DisplayName = "Texte non UTF-8 refuse")]
    public void NotUtf8()
    {
        var errors = new List<string>();
        NotesArchive.Read(Zip(("a.md", [0xC3, 0x28])), errors);
        errors.Should().ContainSingle().Which.Should().Contain("UTF-8");
    }
}
