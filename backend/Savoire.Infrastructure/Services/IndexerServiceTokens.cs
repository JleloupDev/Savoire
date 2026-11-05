// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Jeton presente par l'API au pair indexeur (ADR-028).
//
// Identite chez le fournisseur (Indexer:Oidc) : jeton « client credentials »
// du compte de service savoire-api, garde jusqu'a une minute avant son
// expiration, une seule demande a la fois. Sinon : le jeton partage
// Indexer:ServiceToken.

using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;
using Savoire.Application.Indexer;

namespace Savoire.Infrastructure.Services;

public sealed class IndexerServiceTokens(IHttpClientFactory httpClients, IOptionsMonitor<IndexerOptions> options, TimeProvider clock)
{
    public const string HttpClientName = "savoire-indexer-identity";

    private readonly SemaphoreSlim gate = new(1, 1);
    private (string Token, DateTimeOffset RenewAt, string Key)? current;

    public async Task<string?> GetAsync(CancellationToken ct)
    {
        IndexerOptions opts = options.CurrentValue;
        if (!opts.Oidc.Configured) return opts.ServiceToken;

        string key = $"{opts.Oidc.TokenEndpoint}|{opts.Oidc.ClientId}";
        if (current is { } c && c.Key == key && clock.GetUtcNow() < c.RenewAt) return c.Token;
        await gate.WaitAsync(ct);
        try
        {
            if (current is { } again && again.Key == key && clock.GetUtcNow() < again.RenewAt) return again.Token;
            var form = new Dictionary<string, string> { ["grant_type"] = "client_credentials" };
            if (!string.IsNullOrWhiteSpace(opts.Oidc.Scope)) form["scope"] = opts.Oidc.Scope!;
            using var request = new HttpRequestMessage(HttpMethod.Post, opts.Oidc.TokenEndpoint) { Content = new FormUrlEncodedContent(form) };
            string basic = Convert.ToBase64String(Encoding.UTF8.GetBytes(
                $"{Uri.EscapeDataString(opts.Oidc.ClientId!)}:{Uri.EscapeDataString(opts.Oidc.ClientSecret!)}"));
            request.Headers.Authorization = new AuthenticationHeaderValue("Basic", basic);
            using HttpResponseMessage response = await httpClients.CreateClient(HttpClientName).SendAsync(request, ct);
            string body = await response.Content.ReadAsStringAsync(ct);
            if (!response.IsSuccessStatusCode)
                throw new HttpRequestException($"Fournisseur d'identite : jeton de service refuse ({(int)response.StatusCode}).");
            using JsonDocument doc = JsonDocument.Parse(body);
            string token = doc.RootElement.GetProperty("access_token").GetString()
                ?? throw new HttpRequestException("Fournisseur d'identite : reponse sans jeton.");
            int lifetime = doc.RootElement.TryGetProperty("expires_in", out JsonElement e) && e.TryGetInt32(out int s) ? s : 300;
            current = (token, clock.GetUtcNow().AddSeconds(Math.Max(60, lifetime) - 60), key);
            return token;
        }
        finally
        {
            gate.Release();
        }
    }

    /// <summary>Jeton refuse par le pair (401) : le suivant sera neuf.</summary>
    public void Invalidate() => current = null;
}
