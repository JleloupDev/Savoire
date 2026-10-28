// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Client HTTP de l'API du pair indexeur (docs/Architecture/indexer-protocol.md).
//
// Client nomme d'IHttpClientFactory (« savoire-indexer ») : les tests
// remplacent son gestionnaire par un faux pair. Jeton de service en
// Authorization: Bearer, delai Indexer:TimeoutMs, reponse lue au plus
// Indexer:MaxResponseBytes. Ne leve pas pour un pair absent : rend un
// IndexerPeerResponse que le relais traduit en 503.

using System.Net.Http.Headers;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Savoire.Application.Abstractions;
using Savoire.Application.Indexer;

namespace Savoire.Infrastructure.Services;

public sealed class HttpIndexerPeerClient(
    IHttpClientFactory              httpClients,
    IOptionsMonitor<IndexerOptions> options,
    ILogger<HttpIndexerPeerClient>  logger) : IIndexerPeerClient
{
    public const string HttpClientName = "savoire-indexer";

    public Task<IndexerPeerResponse> CallAsync(IndexerInstanceOptions instance, string vaultId, byte[] jsonBody, CancellationToken ct = default) =>
        SendAsync(instance, HttpMethod.Post, $"v1/vaults/{Uri.EscapeDataString(vaultId)}/call", jsonBody, ct);

    public Task<IndexerPeerResponse> SearchAsync(IndexerInstanceOptions instance, byte[] jsonBody, CancellationToken ct = default) =>
        SendAsync(instance, HttpMethod.Post, "v1/search", jsonBody, ct);

    public Task<IndexerPeerResponse> StatusAsync(IndexerInstanceOptions instance, string vaultId, CancellationToken ct = default) =>
        SendAsync(instance, HttpMethod.Get, $"v1/vaults/{Uri.EscapeDataString(vaultId)}/status", null, ct);

    private async Task<IndexerPeerResponse> SendAsync(
        IndexerInstanceOptions instance, HttpMethod method, string path, byte[]? jsonBody, CancellationToken ct)
    {
        IndexerOptions opts = options.CurrentValue;
        var baseUri = new Uri(instance.Url.EndsWith('/') ? instance.Url : instance.Url + "/");
        using var request = new HttpRequestMessage(method, new Uri(baseUri, path));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", opts.ServiceToken);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        if (jsonBody is not null)
        {
            request.Content = new ByteArrayContent(jsonBody);
            request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json") { CharSet = "utf-8" };
        }

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(opts.TimeoutMs);
        try
        {
            HttpClient http = httpClients.CreateClient(HttpClientName);
            using HttpResponseMessage response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);

            TimeSpan? retryAfter = response.Headers.RetryAfter switch
            {
                { Delta: { } delta } => delta,
                { Date: { } date }   => date - DateTimeOffset.UtcNow,
                _                    => null,
            };

            if (response.Content.Headers.ContentLength > opts.MaxResponseBytes)
                return IndexerPeerResponse.Failed(IndexerPeerOutcome.TooLarge);
            string? body = await ReadBoundedAsync(response.Content, opts.MaxResponseBytes, timeout.Token);
            if (body is null) return IndexerPeerResponse.Failed(IndexerPeerOutcome.TooLarge);

            return new IndexerPeerResponse(IndexerPeerOutcome.Answered, (int)response.StatusCode, body, retryAfter);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            logger.LogWarning("Pair indexeur {Instance} : pas de reponse en {TimeoutMs} ms ({Path})", instance.Name, opts.TimeoutMs, path);
            return IndexerPeerResponse.Failed(IndexerPeerOutcome.TimedOut);
        }
        catch (HttpRequestException ex)
        {
            logger.LogWarning("Pair indexeur {Instance} injoignable ({Path}) : {Message}", instance.Name, path, ex.Message);
            return IndexerPeerResponse.Failed(IndexerPeerOutcome.Unreachable);
        }
    }

    /// <summary>Le corps en texte, ou null s'il depasse <paramref name="max"/> octets.</summary>
    private static async Task<string?> ReadBoundedAsync(HttpContent content, int max, CancellationToken ct)
    {
        await using Stream stream = await content.ReadAsStreamAsync(ct);
        using var buffer = new MemoryStream();
        byte[] chunk = new byte[16 * 1024];
        int read;
        while ((read = await stream.ReadAsync(chunk, ct)) > 0)
        {
            if (buffer.Length + read > max) return null;
            buffer.Write(chunk, 0, read);
        }
        return System.Text.Encoding.UTF8.GetString(buffer.GetBuffer(), 0, (int)buffer.Length);
    }
}
