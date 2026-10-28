// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Relais d'un appel de pouvoir vers le pair indexeur : routage, appelant,
// erreurs du pair, 409 not_owner, pair absent, vault sans pair gere.

using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using Savoire.Application.Abstractions;
using Savoire.Application.Indexer;
using Savoire.Application.Indexer.CallIndexer;
using Savoire.Domain.Enums;
using static Savoire.Server.Unit.Tests.Indexer.IndexerTestDoubles;

namespace Savoire.Server.Unit.Tests.Indexer;

public class CallIndexerQueryHandlerTests
{
    private const string VaultId = "7c9e6679-7425-40de-944b-e07fc1f90ae7"; // idx-b parmi idx-a, idx-b, idx-c
    private readonly IIndexerPeerClient _peer = Substitute.For<IIndexerPeerClient>();

    private CallIndexerQueryHandler Handler(IndexerOptions opts, params Domain.ReadModels.VaultIndexerSetting[] settings) =>
        new(Monitor(opts), Settings(settings), _peer, NullLogger<CallIndexerQueryHandler>.Instance);

    private static CallIndexerQuery Query(string caller = "user-1", string paramsJson = """{"id":"n1"}""") =>
        new(caller, VaultId, "links", "backlinks", paramsJson);

    [Fact(DisplayName = "Relais — l'instance proprietaire recoit capacite, methode, params et l'appelant ; la reponse est result")]
    public async Task Relays_ToOwner_AndReturnsResult()
    {
        byte[]? sent = null;
        _peer.CallAsync(Arg.Any<IndexerInstanceOptions>(), VaultId, Arg.Do<byte[]>(b => sent = b), Arg.Any<CancellationToken>())
            .Returns(Answer(200, """{"result":{"items":[{"id":"n2","count":3}]}}"""));

        IndexerReply reply = await Handler(Options("idx-a", "idx-b", "idx-c")).Handle(Query(), default);

        reply.StatusCode.Should().Be(200);
        Json(reply.Json)["items"]![0]!["id"]!.GetValue<string>().Should().Be("n2");
        await _peer.Received(1).CallAsync(Arg.Is<IndexerInstanceOptions>(i => i.Name == "idx-b"), VaultId, Arg.Any<byte[]>(), Arg.Any<CancellationToken>());
        var body = Json(sent!);
        body["capability"]!.GetValue<string>().Should().Be("links");
        body["method"]!.GetValue<string>().Should().Be("backlinks");
        body["params"]!["id"]!.GetValue<string>().Should().Be("n1");
        body["caller"]!["userId"]!.GetValue<string>().Should().Be("user-1");
    }

    [Fact(DisplayName = "Relais — un « caller » glisse dans les params ne remplace pas l'appelant")]
    public async Task CallerFromParams_IsIgnored()
    {
        byte[]? sent = null;
        _peer.CallAsync(default!, default!, Arg.Do<byte[]>(b => sent = b), default)
            .ReturnsForAnyArgs(Answer(200, """{"result":null}"""));

        await Handler(Options("idx-a")).Handle(Query(paramsJson: """{"caller":{"userId":"admin"}}"""), default);

        Json(sent!)["caller"]!["userId"]!.GetValue<string>().Should().Be("user-1");
    }

    [Fact(DisplayName = "409 not_owner — un nouvel essai apres recalcul, puis la reponse")]
    public async Task NotOwner_RetriesOnce()
    {
        _peer.CallAsync(default!, default!, default!, default)
            .ReturnsForAnyArgs(Error(409, "not_owner"), Answer(200, """{"result":{"ok":true}}"""));

        IndexerReply reply = await Handler(Options("idx-a", "idx-b", "idx-c")).Handle(Query(), default);

        reply.StatusCode.Should().Be(200);
        await _peer.ReceivedWithAnyArgs(2).CallAsync(default!, default!, default!, default);
    }

    [Fact(DisplayName = "409 not_owner deux fois — 503 + Retry-After, pas de troisieme essai")]
    public async Task NotOwnerTwice_Is503()
    {
        _peer.CallAsync(default!, default!, default!, default).ReturnsForAnyArgs(Error(409, "not_owner"));

        IndexerReply reply = await Handler(Options("idx-a")).Handle(Query(), default);

        reply.StatusCode.Should().Be(503);
        reply.RetryAfterSeconds.Should().NotBeNull();
        await _peer.ReceivedWithAnyArgs(2).CallAsync(default!, default!, default!, default);
    }

    [Theory(DisplayName = "Pair injoignable ou trop lent — 503 unavailable + Retry-After")]
    [InlineData(IndexerPeerOutcome.Unreachable)]
    [InlineData(IndexerPeerOutcome.TimedOut)]
    [InlineData(IndexerPeerOutcome.TooLarge)]
    public async Task PeerDown_Is503(IndexerPeerOutcome outcome)
    {
        _peer.CallAsync(default!, default!, default!, default).ReturnsForAnyArgs(IndexerPeerResponse.Failed(outcome));

        IndexerReply reply = await Handler(Options("idx-a")).Handle(Query(), default);

        reply.StatusCode.Should().Be(503);
        reply.RetryAfterSeconds.Should().Be(7);
        Json(reply.Json)["error"]!["code"]!.GetValue<string>().Should().Be("unavailable");
    }

    [Theory(DisplayName = "Erreurs du protocole — rendues telles quelles")]
    [InlineData(400, "invalid_query", null)]
    [InlineData(400, "too_complex", null)]
    [InlineData(404, "unknown_capability", null)]
    [InlineData(429, "overloaded", 3)]
    [InlineData(503, "unavailable", 9)]
    public async Task ProtocolErrors_PassThrough(int status, string code, int? retryAfter)
    {
        _peer.CallAsync(default!, default!, default!, default).ReturnsForAnyArgs(
            Error(status, code, retryAfter is null ? null : TimeSpan.FromSeconds(retryAfter.Value)));

        IndexerReply reply = await Handler(Options("idx-a")).Handle(Query(), default);

        reply.StatusCode.Should().Be(status);
        Json(reply.Json)["error"]!["code"]!.GetValue<string>().Should().Be(code);
        reply.RetryAfterSeconds.Should().Be(retryAfter);
    }

    [Theory(DisplayName = "Erreur interne du pair ou jeton refuse — 503, jamais le detail")]
    [InlineData(500)]
    [InlineData(401)]
    public async Task InternalPeerError_Is503(int status)
    {
        _peer.CallAsync(default!, default!, default!, default).ReturnsForAnyArgs(Answer(status, "stack trace..."));

        IndexerReply reply = await Handler(Options("idx-a")).Handle(Query(), default);

        reply.StatusCode.Should().Be(503);
        reply.Json.Should().NotContain("stack trace");
    }

    [Fact(DisplayName = "Pair non configure — 503 + Retry-After, aucun appel")]
    public async Task Disabled_Is503()
    {
        var opts = Options("idx-a");
        opts.ServiceToken = null;

        IndexerReply reply = await Handler(opts).Handle(Query(), default);

        reply.StatusCode.Should().Be(503);
        reply.RetryAfterSeconds.Should().Be(7);
        await _peer.DidNotReceiveWithAnyArgs().CallAsync(default!, default!, default!, default);
    }

    [Fact(DisplayName = "Vault en mode none — 503 + Retry-After, mode rendu")]
    public async Task ModeNone_Is503()
    {
        IndexerReply reply = await Handler(Options("idx-a"), Mode(VaultId, IndexerMode.None)).Handle(Query(), default);

        reply.StatusCode.Should().Be(503);
        reply.RetryAfterSeconds.Should().Be(7);
        Json(reply.Json)["mode"]!.GetValue<string>().Should().Be("none");
        await _peer.DidNotReceiveWithAnyArgs().CallAsync(default!, default!, default!, default);
    }

    [Fact(DisplayName = "Vault en mode organization — 503 avec { mode, url }, sans Retry-After ni relais")]
    public async Task ModeOrganization_ReturnsUrl()
    {
        IndexerReply reply = await Handler(Options("idx-a"),
            Mode(VaultId, IndexerMode.Organization, "https://idx.example.org")).Handle(Query(), default);

        reply.StatusCode.Should().Be(503);
        reply.RetryAfterSeconds.Should().BeNull();
        var body = Json(reply.Json);
        body["mode"]!.GetValue<string>().Should().Be("organization");
        body["url"]!.GetValue<string>().Should().Be("https://idx.example.org");
        await _peer.DidNotReceiveWithAnyArgs().CallAsync(default!, default!, default!, default);
    }

    [Theory(DisplayName = "Lien de partage ou jeton de lecture — refuse")]
    [InlineData("share:abc")]
    [InlineData("view:v:d:read")]
    public async Task LinkCaller_IsDenied(string caller)
    {
        Func<Task> act = () => Handler(Options("idx-a")).Handle(Query(caller), default);
        await act.Should().ThrowAsync<AccessDeniedException>();
    }
}
