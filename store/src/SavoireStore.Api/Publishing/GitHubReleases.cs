// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Publication comme Obsidian : l'editeur fait une « release » GitHub de son
// depot, avec manifest.json et les fichiers du paquet en pieces jointes
// (main.js, styles.css pour un plugin ; template.md pour un modele ;
// module.md pour un module ; notes.zip pour un paquet de notes). Le store lit la derniere release.
using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace SavoireStore.Publishing;

public sealed record ReleaseAsset(string Name, long Size, string DownloadUrl);
public sealed record Release(string Tag, string HtmlUrl, IReadOnlyList<ReleaseAsset> Assets);

public sealed class PublishException(int status, string code, string message) : Exception(message)
{
    public int Status { get; } = status;
    public string Code { get; } = code;
}

public sealed partial class GitHubReleases(IHttpClientFactory http, IConfiguration config)
{
    public const string HttpClientName = "github";
    public const long MaxAssetBytes = 5 * 1024 * 1024;

    [GeneratedRegex(@"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$")]
    public static partial Regex RepoRegex();

    public async Task<Release> LatestAsync(string repo, CancellationToken ct)
    {
        if (!RepoRegex().IsMatch(repo)) throw new PublishException(400, "invalid_repo", "Depot attendu sous la forme proprietaire/nom.");
        using HttpResponseMessage resp = await Client().GetAsync($"https://api.github.com/repos/{repo}/releases/latest", ct);
        if (resp.StatusCode == HttpStatusCode.NotFound)
            throw new PublishException(404, "no_release", "Aucune release publiee sur ce depot (ou depot introuvable).");
        if (!resp.IsSuccessStatusCode)
            throw new PublishException(502, "github_unavailable", $"GitHub a repondu {(int)resp.StatusCode}.");
        using JsonDocument doc = JsonDocument.Parse(await resp.Content.ReadAsStreamAsync(ct));
        JsonElement r = doc.RootElement;
        var assets = new List<ReleaseAsset>();
        if (r.TryGetProperty("assets", out JsonElement list) && list.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement a in list.EnumerateArray())
                assets.Add(new ReleaseAsset(a.GetProperty("name").GetString() ?? "", a.GetProperty("size").GetInt64(),
                    a.GetProperty("browser_download_url").GetString() ?? ""));
        }
        return new Release(r.GetProperty("tag_name").GetString() ?? "", r.TryGetProperty("html_url", out JsonElement u) ? u.GetString() ?? "" : "", assets);
    }

    /// <summary>Le texte d'une piece jointe (5 Mio au plus).</summary>
    public async Task<string> DownloadTextAsync(ReleaseAsset asset, CancellationToken ct)
    {
        (byte[] bytes, int length) = await DownloadAsync(asset, MaxAssetBytes, ct);
        return System.Text.Encoding.UTF8.GetString(bytes, 0, length);
    }

    /// <summary>Les octets d'une piece jointe (`max` au plus).</summary>
    public async Task<byte[]> DownloadBytesAsync(ReleaseAsset asset, long max, CancellationToken ct)
    {
        (byte[] bytes, int length) = await DownloadAsync(asset, max, ct);
        return bytes[..length];
    }

    private async Task<(byte[] Buffer, int Length)> DownloadAsync(ReleaseAsset asset, long max, CancellationToken ct)
    {
        string limit = $"{max / (1024 * 1024)} Mio";
        if (asset.Size > max) throw new PublishException(413, "asset_too_large", $"{asset.Name} depasse {limit}.");
        if (!asset.DownloadUrl.StartsWith("https://", StringComparison.Ordinal))
            throw new PublishException(400, "invalid_asset", $"Adresse de {asset.Name} invalide.");
        using HttpResponseMessage resp = await Client().GetAsync(asset.DownloadUrl, HttpCompletionOption.ResponseHeadersRead, ct);
        if (!resp.IsSuccessStatusCode) throw new PublishException(502, "github_unavailable", $"Telechargement de {asset.Name} : {(int)resp.StatusCode}.");
        await using Stream s = await resp.Content.ReadAsStreamAsync(ct);
        using var buffer = new MemoryStream();
        byte[] chunk = new byte[16 * 1024];
        int n;
        while ((n = await s.ReadAsync(chunk, ct)) > 0)
        {
            if (buffer.Length + n > max) throw new PublishException(413, "asset_too_large", $"{asset.Name} depasse {limit}.");
            buffer.Write(chunk, 0, n);
        }
        return (buffer.GetBuffer(), (int)buffer.Length);
    }

    private HttpClient Client()
    {
        HttpClient c = http.CreateClient(HttpClientName);
        c.DefaultRequestHeaders.UserAgent.ParseAdd("savoire-store");
        c.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");
        if (config["Store:GitHubToken"] is { Length: > 0 } token)
            c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return c;
    }
}
