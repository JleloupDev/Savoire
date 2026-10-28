// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Client HTTP du pair indexeur, devant un faux pair (HttpMessageHandler de
// test) : jeton, adresses, delai, pair absent, reponse trop grosse, Retry-After.

using System.Net;
using System.Text;
using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using Savoire.Application.Abstractions;
using Savoire.Application.Indexer;
using Savoire.Infrastructure.Services;
using Savoire.Server.Middleware;
using static Savoire.Server.Unit.Tests.Indexer.IndexerTestDoubles;

namespace Savoire.Server.Unit.Tests.Indexer;

public class HttpIndexerPeerClientTests
{
    private sealed class FakePeer(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> respond) : HttpMessageHandler
    {
        public List<(HttpRequestMessage Request, string? Body)> Seen { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            string? body = request.Content is null ? null : await request.Content.ReadAsStringAsync(ct);
            Seen.Add((request, body));
            return await respond(request, ct);
        }
    }

    private static readonly IndexerInstanceOptions Instance = new() { Name = "idx-a", Url = "http://idx-a.test:7070" };

    private static (HttpIndexerPeerClient Client, FakePeer Peer) Create(
        Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> respond, Action<IndexerOptions>? tune = null)
    {
        var peer = new FakePeer(respond);
        var factory = Substitute.For<IHttpClientFactory>();
        factory.CreateClient(HttpIndexerPeerClient.HttpClientName).Returns(_ => new HttpClient(peer, disposeHandler: false));
        IndexerOptions opts = Options("idx-a");
        tune?.Invoke(opts);
        return (new HttpIndexerPeerClient(factory, Monitor(opts), NullLogger<HttpIndexerPeerClient>.Instance), peer);
    }

    private static Task<HttpResponseMessage> Json(HttpStatusCode status, string body)
    {
        var response = new HttpResponseMessage(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        return Task.FromResult(response);
    }

    [Fact(DisplayName = "Appel — POST /v1/vaults/{id}/call avec le jeton de service et le corps")]
    public async Task Call_PostsWithServiceToken()
    {
        var (client, peer) = Create((_, _) => Json(HttpStatusCode.OK, """{"result":1}"""));

        IndexerPeerResponse response = await client.CallAsync(Instance, "vault 1", Encoding.UTF8.GetBytes("""{"a":1}"""));

        response.IsSuccess.Should().BeTrue();
        response.Body.Should().Be("""{"result":1}""");
        var (request, body) = peer.Seen.Single();
        request.Method.Should().Be(HttpMethod.Post);
        request.RequestUri!.AbsoluteUri.Should().Be("http://idx-a.test:7070/v1/vaults/vault%201/call");
        request.Headers.Authorization!.Scheme.Should().Be("Bearer");
        request.Headers.Authorization.Parameter.Should().Be("service-token");
        body.Should().Be("""{"a":1}""");
    }

    [Fact(DisplayName = "Recherche et etat — /v1/search et GET /v1/vaults/{id}/status")]
    public async Task SearchAndStatus_Paths()
    {
        var (client, peer) = Create((_, _) => Json(HttpStatusCode.OK, "{}"));
        await client.SearchAsync(Instance, "{}"u8.ToArray());
        await client.StatusAsync(Instance, "v1");
        peer.Seen.Select(s => $"{s.Request.Method} {s.Request.RequestUri!.AbsolutePath}")
            .Should().Equal("POST /v1/search", "GET /v1/vaults/v1/status");
    }

    [Fact(DisplayName = "Pair trop lent — TimedOut apres Indexer:TimeoutMs")]
    public async Task Slow_TimesOut()
    {
        var (client, _) = Create(async (_, ct) =>
        {
            await Task.Delay(TimeSpan.FromSeconds(30), ct);
            return new HttpResponseMessage(HttpStatusCode.OK);
        }, o => o.TimeoutMs = 100);

        IndexerPeerResponse response = await client.CallAsync(Instance, "v", "{}"u8.ToArray());
        response.Outcome.Should().Be(IndexerPeerOutcome.TimedOut);
    }

    [Fact(DisplayName = "Pair absent — Unreachable, sans exception")]
    public async Task Down_IsUnreachable()
    {
        var (client, _) = Create((_, _) => throw new HttpRequestException("connection refused"));
        IndexerPeerResponse response = await client.CallAsync(Instance, "v", "{}"u8.ToArray());
        response.Outcome.Should().Be(IndexerPeerOutcome.Unreachable);
    }

    [Fact(DisplayName = "Reponse plus grosse que Indexer:MaxResponseBytes — TooLarge")]
    public async Task TooLarge()
    {
        var (client, _) = Create((_, _) => Json(HttpStatusCode.OK, new string('x', 5000)), o => o.MaxResponseBytes = 1000);
        IndexerPeerResponse response = await client.CallAsync(Instance, "v", "{}"u8.ToArray());
        response.Outcome.Should().Be(IndexerPeerOutcome.TooLarge);
    }

    [Fact(DisplayName = "Erreur du pair — statut, corps et Retry-After rendus")]
    public async Task Error_KeepsStatusAndRetryAfter()
    {
        var (client, _) = Create(async (_, _) =>
        {
            HttpResponseMessage r = await Json(HttpStatusCode.TooManyRequests, """{"error":{"code":"overloaded","message":""}}""");
            r.Headers.RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(TimeSpan.FromSeconds(4));
            return r;
        });
        IndexerPeerResponse response = await client.CallAsync(Instance, "v", "{}"u8.ToArray());
        response.Outcome.Should().Be(IndexerPeerOutcome.Answered);
        response.StatusCode.Should().Be(429);
        response.RetryAfter.Should().Be(TimeSpan.FromSeconds(4));
        IndexerRelay.ErrorCode(response.Body).Should().Be("overloaded");
    }
}

public class IndexerServiceTokenTests
{
    [Theory(DisplayName = "Jeton de service — comparaison exacte")]
    [InlineData("secret-123", "secret-123", true)]
    [InlineData("secret-124", "secret-123", false)]
    [InlineData("secret-12", "secret-123", false)]
    [InlineData("", "secret-123", false)]
    public void TokenMatches(string presented, string expected, bool match) =>
        IndexerServiceTokenAttribute.TokenMatches(presented, expected).Should().Be(match);
}
