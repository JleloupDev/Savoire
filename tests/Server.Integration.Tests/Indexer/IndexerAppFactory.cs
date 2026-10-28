// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Serveur de test avec le pair indexeur configure (jeton de service, trois
// instances) devant un faux pair : un HttpMessageHandler qui note les
// requetes et repond ce que le test lui dit.

using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Savoire.Application.Common;
using Savoire.Application.Indexer;
using Savoire.Infrastructure.Services;

namespace Savoire.Server.Integration.Tests.Indexer;

/// <summary>Une requete recue par le faux pair.</summary>
public sealed record PeerRequest(string Method, string Instance, string Path, string? Authorization, string? Body);

public sealed class FakeIndexerPeer : HttpMessageHandler
{
    public ConcurrentQueue<PeerRequest> Requests { get; } = new();

    /// <summary>Reponse du faux pair ; par defaut 200 { result: { ok: true } }.</summary>
    public Func<PeerRequest, HttpResponseMessage> Respond { get; set; } = _ => Json(HttpStatusCode.OK, """{"result":{"ok":true}}""");

    public void Reset(Func<PeerRequest, HttpResponseMessage>? respond = null)
    {
        Requests.Clear();
        Respond = respond ?? (_ => Json(HttpStatusCode.OK, """{"result":{"ok":true}}"""));
    }

    public static HttpResponseMessage Json(HttpStatusCode status, string body, int? retryAfter = null)
    {
        var response = new HttpResponseMessage(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        if (retryAfter is int s) response.Headers.RetryAfter = new RetryConditionHeaderValue(TimeSpan.FromSeconds(s));
        return response;
    }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        string? body = request.Content is null ? null : await request.Content.ReadAsStringAsync(ct);
        string instance = request.RequestUri!.Host.Split('.')[0];
        var seen = new PeerRequest(request.Method.Method, instance, request.RequestUri.AbsolutePath,
            request.Headers.Authorization?.ToString(), body);
        Requests.Enqueue(seen);
        return Respond(seen);
    }
}

public class IndexerAppFactory : AppFactory
{
    public const string ServiceToken = "test-indexer-service-token-0123456789";
    public static readonly IndexerInstanceOptions[] Instances =
    [
        new() { Name = "idx-a", Url = "http://idx-a.test:7070" },
        new() { Name = "idx-b", Url = "http://idx-b.test:7070" },
        new() { Name = "idx-c", Url = "http://idx-c.test:7070" },
    ];

    public FakeIndexerPeer Peer { get; } = new();

    protected virtual int PerUserPerMinute => 100_000;
    protected virtual int PerVaultPerMinute => 100_000;

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        base.ConfigureWebHost(builder);
        var settings = new Dictionary<string, string?>
        {
            ["Indexer:ServiceToken"]                = ServiceToken,
            ["Indexer:TimeoutMs"]                   = "3000",
            ["Indexer:RetryAfterSeconds"]           = "5",
            ["Indexer:RateLimit:PerUserPerMinute"]  = PerUserPerMinute.ToString(),
            ["Indexer:RateLimit:PerVaultPerMinute"] = PerVaultPerMinute.ToString(),
        };
        for (int i = 0; i < Instances.Length; i++)
        {
            settings[$"Indexer:Instances:{i}:Name"] = Instances[i].Name;
            settings[$"Indexer:Instances:{i}:Url"]  = Instances[i].Url;
        }
        builder.ConfigureAppConfiguration(config => config.AddInMemoryCollection(settings));
        builder.ConfigureTestServices(services => services
            .AddHttpClient(HttpIndexerPeerClient.HttpClientName)
            .ConfigurePrimaryHttpMessageHandler(() => Peer)
            .SetHandlerLifetime(Timeout.InfiniteTimeSpan));
    }

    public static string OwnerOf(string vaultId) => IndexerRouting.OwnerOf(vaultId, Instances)!.Name;

    /// <summary>Client de l'API interne, avec ce jeton (null : sans en-tete).</summary>
    public HttpClient ServiceClient(string? token = ServiceToken)
    {
        HttpClient client = CreateClient();
        if (token is not null) client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return client;
    }
}

/// <summary>Outils communs : comptes, vaults, hubs.</summary>
public static class IndexerTestKit
{
    public static HttpClient Client(this AppFactory factory, string token)
    {
        HttpClient client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return client;
    }

    public static async Task<string> NewVaultAsync(this AppFactory factory, string token, string userId, string name = "Vault indexe")
    {
        var resp = await factory.Client(token).PostAsJsonAsync($"/api/v1/users/{userId}/vaults", new { name });
        resp.EnsureSuccessStatusCode();
        return (await resp.Content.ReadFromJsonAsync<VaultSummaryDto>())!.Id;
    }

    public static async Task<HubConnection> HubAsync(this AppFactory factory, string path, string token)
    {
        HubConnection conn = new HubConnectionBuilder()
            .WithUrl($"http://localhost{path}", options =>
            {
                options.HttpMessageHandlerFactory = _ => factory.Server.CreateHandler();
                options.Transports = HttpTransportType.LongPolling;
                options.AccessTokenProvider = () => Task.FromResult<string?>(token);
            })
            .Build();
        await conn.StartAsync();
        return conn;
    }

    public static string B64(params byte[] bytes) => Convert.ToBase64String(bytes);
}
