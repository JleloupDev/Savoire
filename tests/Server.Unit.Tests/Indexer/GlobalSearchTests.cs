// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Recherche globale : fusion par score, curseur compose, instances en echec.

using System.Text.Json.Nodes;
using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using Savoire.Application.Abstractions;
using Savoire.Application.Indexer;
using Savoire.Application.Indexer.SearchAllVaults;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Enums;
using Savoire.Domain.Repositories;
using static Savoire.Server.Unit.Tests.Indexer.IndexerTestDoubles;

namespace Savoire.Server.Unit.Tests.Indexer;

public class GlobalSearchMergeTests
{
    private static JsonObject Hit(string id, double score, string vaultId = "v") =>
        new() { ["id"] = id, ["score"] = score, ["vaultId"] = vaultId, ["path"] = $"{id}.md", ["title"] = id, ["snippets"] = new JsonArray() };

    private static InstanceSearchPage Page(string name, string? next, int skip, params JsonObject[] hits) =>
        new(name, new GlobalSearchPart(null, skip), hits, next);

    [Fact(DisplayName = "Fusion — score decroissant, puis vaultId, puis id")]
    public void Merge_OrdersByScore_ThenVault_ThenId()
    {
        var (hits, remaining) = GlobalSearchMerge.Merge(
        [
            Page("idx-a", null, 0, Hit("a1", 9), Hit("a2", 5, "v2"), Hit("a3", 1)),
            Page("idx-b", null, 0, Hit("b1", 7), Hit("b2", 5, "v1"), Hit("b3", 0.5)),
        ], limit: 10);

        hits.Select(h => h["id"]!.GetValue<string>()).Should().Equal("a1", "b1", "b2", "a2", "a3", "b3");
        remaining.Should().BeEmpty();
    }

    [Fact(DisplayName = "Fusion — limite atteinte : chaque instance garde sa position")]
    public void Merge_Limit_KeepsPositions()
    {
        var (hits, remaining) = GlobalSearchMerge.Merge(
        [
            Page("idx-a", null, 0, Hit("a1", 9), Hit("a2", 5), Hit("a3", 1)),
            Page("idx-b", "b-next", 0, Hit("b1", 7), Hit("b2", 6)),
        ], limit: 3);

        hits.Select(h => h["id"]!.GetValue<string>()).Should().Equal("a1", "b1", "b2");
        remaining["idx-a"].Should().Be(new GlobalSearchPart(null, 1));
        remaining["idx-b"].Should().Be(new GlobalSearchPart("b-next", 0));
    }

    [Fact(DisplayName = "Fusion — une instance epuise sa page mais a une suite : on s'arrete (page courte)")]
    public void Merge_StopsWhenAPageRunsOutButHasMore()
    {
        var (hits, remaining) = GlobalSearchMerge.Merge(
        [
            Page("idx-a", "a-next", 0, Hit("a1", 9)),
            Page("idx-b", null, 0, Hit("b1", 7), Hit("b2", 6)),
        ], limit: 10);

        hits.Select(h => h["id"]!.GetValue<string>()).Should().Equal("a1");
        remaining["idx-a"].Should().Be(new GlobalSearchPart("a-next", 0));
        remaining["idx-b"].Should().Be(new GlobalSearchPart(null, 0));
    }

    [Fact(DisplayName = "Fusion — reprise : les resultats deja rendus d'une page sont sautes")]
    public void Merge_SkipsAlreadyReturned()
    {
        var (hits, _) = GlobalSearchMerge.Merge([Page("idx-a", null, 2, Hit("a1", 9), Hit("a2", 5), Hit("a3", 1))], limit: 10);
        hits.Select(h => h["id"]!.GetValue<string>()).Should().Equal("a3");
    }

    [Fact(DisplayName = "Curseur compose — aller-retour ; illisible : null")]
    public void Cursor_RoundTrips()
    {
        var cursor = new GlobalSearchCursor(new Dictionary<string, GlobalSearchPart>
        {
            ["idx-a"] = new("c+/=", 3),
            ["idx-b"] = new(null, 0),
        }, Partial: true);

        GlobalSearchCursor decoded = GlobalSearchCursor.Decode(cursor.Encode())!;
        decoded.Partial.Should().BeTrue();
        decoded.Parts["idx-a"].Should().Be(new GlobalSearchPart("c+/=", 3));
        decoded.Parts["idx-b"].Should().Be(new GlobalSearchPart(null, 0));
        GlobalSearchCursor.Decode("pas un curseur").Should().BeNull();
        GlobalSearchCursor.Decode("e30").Should().BeNull(); // « {} »
    }

    [Fact(DisplayName = "Etat d'index — le moins avance l'emporte")]
    public void WorstIndex_IsLeastAdvanced()
    {
        JsonObject index = GlobalSearchMerge.WorstIndex(
        [
            new JsonObject { ["status"] = "ready" },
            new JsonObject { ["status"] = "building", ["progress"] = 0.4 },
            new JsonObject { ["status"] = "lagging", ["lagMs"] = 1500 },
        ]);
        index["status"]!.GetValue<string>().Should().Be("building");
        index["progress"]!.GetValue<double>().Should().Be(0.4);
        index["lagMs"]!.GetValue<long>().Should().Be(1500);
    }
}

public class SearchAllVaultsQueryHandlerTests
{
    // Proprietaires parmi idx-a, idx-b, idx-c (vecteurs du protocole).
    private const string OnA = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
    private const string OnA2 = "0b6f3c2e-9d61-4c1a-8b8e-2f1d5a7c9e40";
    private const string OnB = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    private const string OnC = "d3b07384-d9a0-4c3b-9f7e-1a2b3c4d5e6f";

    private readonly IIndexerPeerClient _peer = Substitute.For<IIndexerPeerClient>();
    private readonly IVaultRepository _vaults = Substitute.For<IVaultRepository>();

    public SearchAllVaultsQueryHandlerTests()
    {
        _vaults.GetForUserAsync("user-1", Arg.Any<CancellationToken>()).Returns(
            new List<(Vault, VaultRole)>
            {
                (Vault.Rehydrate(OnA, "A", "user-1", DateTime.UtcNow), VaultRole.Owner),
                (Vault.Rehydrate(OnA2, "A2", "user-1", DateTime.UtcNow), VaultRole.Owner),
                (Vault.Rehydrate(OnB, "B", "other", DateTime.UtcNow), VaultRole.Viewer),
                (Vault.Rehydrate(OnC, "C", "other", DateTime.UtcNow), VaultRole.Editor),
            });
    }

    private SearchAllVaultsQueryHandler Handler(params Domain.ReadModels.VaultIndexerSetting[] settings) =>
        new(Monitor(Options("idx-a", "idx-b", "idx-c")), _vaults, Settings(settings), _peer,
            NullLogger<SearchAllVaultsQueryHandler>.Instance);

    private static string Result(string instance, params (string Id, double Score, string VaultId)[] hits) =>
        new JsonObject
        {
            ["hits"] = new JsonArray(hits.Select(h => (JsonNode)new JsonObject
            {
                ["id"] = h.Id, ["score"] = h.Score, ["vaultId"] = h.VaultId,
                ["path"] = $"{h.Id}.md", ["title"] = h.Id, ["snippets"] = new JsonArray(),
            }).ToArray()),
            ["total"] = hits.Length,
            ["index"] = new JsonObject { ["status"] = "ready" },
        }.ToJsonString();

    private void Answers(string instance, IndexerPeerResponse response) =>
        _peer.SearchAsync(Arg.Is<IndexerInstanceOptions>(i => i.Name == instance), Arg.Any<byte[]>(), Arg.Any<CancellationToken>())
            .Returns(response);

    [Fact(DisplayName = "Recherche globale — vaults groupes par instance, resultats fusionnes par score")]
    public async Task GroupsByInstance_AndMerges()
    {
        var bodies = new Dictionary<string, JsonObject>();
        _peer.SearchAsync(Arg.Any<IndexerInstanceOptions>(), Arg.Any<byte[]>(), Arg.Any<CancellationToken>())
            .Returns(ci =>
            {
                string name = ci.Arg<IndexerInstanceOptions>().Name;
                lock (bodies) bodies[name] = Json(ci.Arg<byte[]>());
                return name switch
                {
                    "idx-a" => Answer(200, Result(name, ("a1", 3, OnA), ("a2", 1, OnA2))),
                    "idx-b" => Answer(200, Result(name, ("b1", 2, OnB))),
                    _       => Answer(200, Result(name, ("c1", 4, OnC))),
                };
            });

        IndexerReply reply = await Handler().Handle(new SearchAllVaultsQuery("user-1", """{"text":"x"}"""), default);

        reply.StatusCode.Should().Be(200);
        JsonObject result = Json(reply.Json);
        result["hits"]!.AsArray().Select(h => h!["id"]!.GetValue<string>()).Should().Equal("c1", "a1", "b1", "a2");
        result["total"]!.GetValue<long>().Should().Be(4);
        result["partial"].Should().BeNull();
        result["next"].Should().BeNull();
        bodies["idx-a"]["vaultIds"]!.AsArray().Select(v => v!.GetValue<string>()).Should().BeEquivalentTo([OnA, OnA2]);
        bodies["idx-a"]["query"]!["text"]!.GetValue<string>().Should().Be("x");
        bodies["idx-a"]["caller"]!["userId"]!.GetValue<string>().Should().Be("user-1");
    }

    [Fact(DisplayName = "Recherche globale — une instance en echec : partial, pas une erreur")]
    public async Task OneInstanceDown_IsPartial()
    {
        Answers("idx-a", Answer(200, Result("idx-a", ("a1", 3, OnA))));
        Answers("idx-b", IndexerPeerResponse.Failed(IndexerPeerOutcome.Unreachable));
        Answers("idx-c", Error(503, "unavailable"));

        IndexerReply reply = await Handler().Handle(new SearchAllVaultsQuery("user-1", """{"text":"x"}"""), default);

        reply.StatusCode.Should().Be(200);
        JsonObject result = Json(reply.Json);
        result["partial"]!.GetValue<bool>().Should().BeTrue();
        result["hits"]!.AsArray().Should().ContainSingle();
    }

    [Fact(DisplayName = "Recherche globale — toutes les instances en echec : 503")]
    public async Task AllDown_Is503()
    {
        _peer.SearchAsync(default!, default!, default).ReturnsForAnyArgs(IndexerPeerResponse.Failed(IndexerPeerOutcome.TimedOut));
        IndexerReply reply = await Handler().Handle(new SearchAllVaultsQuery("user-1", """{"text":"x"}"""), default);
        reply.StatusCode.Should().Be(503);
        reply.RetryAfterSeconds.Should().NotBeNull();
    }

    [Fact(DisplayName = "Recherche globale — vaultIds restreint aux vaults lisibles ; un vault en mode none est ecarte")]
    public async Task VaultIds_AreIntersected_AndNonManagedSkipped()
    {
        Answers("idx-a", Answer(200, Result("idx-a")));

        IndexerReply reply = await Handler(Mode(OnA2, IndexerMode.None)).Handle(new SearchAllVaultsQuery("user-1",
            $$"""{"text":"x","vaultIds":["{{OnA}}","{{OnA2}}","vault-d-un-autre"]}"""), default);

        reply.StatusCode.Should().Be(200);
        await _peer.Received(1).SearchAsync(Arg.Is<IndexerInstanceOptions>(i => i.Name == "idx-a"),
            Arg.Is<byte[]>(b => Json(b)["vaultIds"]!.AsArray().Count == 1 && Json(b)["vaultIds"]![0]!.GetValue<string>() == OnA),
            Arg.Any<CancellationToken>());
        await _peer.DidNotReceive().SearchAsync(Arg.Is<IndexerInstanceOptions>(i => i.Name != "idx-a"), Arg.Any<byte[]>(), Arg.Any<CancellationToken>());
    }

    [Fact(DisplayName = "Recherche globale — page suivante : curseur compose, chaque instance reprend ou elle en etait")]
    public async Task Pagination_WithCompositeCursor()
    {
        _peer.SearchAsync(Arg.Is<IndexerInstanceOptions>(i => i.Name == "idx-a"), Arg.Any<byte[]>(), Arg.Any<CancellationToken>())
            .Returns(ci => Json(ci.Arg<byte[]>())["query"]!["cursor"] is null
                ? Answer(200, Result("idx-a", ("a1", 9, OnA), ("a2", 1, OnA)).Replace("\"total\"", "\"next\":\"a-p2\",\"total\""))
                : Answer(200, Result("idx-a", ("a3", 0.5, OnA))));
        Answers("idx-b", Answer(200, Result("idx-b", ("b1", 5, OnB))));
        Answers("idx-c", Answer(200, Result("idx-c")));

        IndexerReply first = await Handler().Handle(new SearchAllVaultsQuery("user-1", """{"text":"x","limit":2}"""), default);
        JsonObject page1 = Json(first.Json);
        page1["hits"]!.AsArray().Select(h => h!["id"]!.GetValue<string>()).Should().Equal("a1", "b1");
        string next = page1["next"]!.GetValue<string>();

        IndexerReply second = await Handler().Handle(new SearchAllVaultsQuery("user-1",
            $$"""{"text":"x","limit":2,"cursor":"{{next}}"}"""), default);
        JsonObject page2 = Json(second.Json);
        // a2 (reste de la page 1 de idx-a), puis idx-a epuise sa page et a une suite : arret.
        page2["hits"]!.AsArray().Select(h => h!["id"]!.GetValue<string>()).Should().Equal("a2");
        string next2 = page2["next"]!.GetValue<string>();

        IndexerReply third = await Handler().Handle(new SearchAllVaultsQuery("user-1",
            $$"""{"text":"x","limit":2,"cursor":"{{next2}}"}"""), default);
        JsonObject page3 = Json(third.Json);
        page3["hits"]!.AsArray().Select(h => h!["id"]!.GetValue<string>()).Should().Equal("a3");
        page3["next"].Should().BeNull();
    }

    [Theory(DisplayName = "Recherche globale — corps refuse : 400")]
    [InlineData("[]", "invalid_query")]
    [InlineData("""{"text":"x","vaultIds":"v"}""", "invalid_query")]
    [InlineData("""{"text":"x","limit":0}""", "invalid_query")]
    [InlineData("""{"text":"x","cursor":"???"}""", "invalid_cursor")]
    public async Task BadBody_Is400(string body, string code)
    {
        IndexerReply reply = await Handler().Handle(new SearchAllVaultsQuery("user-1", body), default);
        reply.StatusCode.Should().Be(400);
        Json(reply.Json)["error"]!["code"]!.GetValue<string>().Should().Be(code);
    }

    [Fact(DisplayName = "Recherche globale — requete refusee par le pair : 400 rendu tel quel")]
    public async Task InvalidQueryFromPeer_Is400()
    {
        _peer.SearchAsync(default!, default!, default).ReturnsForAnyArgs(Error(400, "too_complex"));
        IndexerReply reply = await Handler().Handle(new SearchAllVaultsQuery("user-1", """{"text":"x"}"""), default);
        reply.StatusCode.Should().Be(400);
        Json(reply.Json)["error"]!["code"]!.GetValue<string>().Should().Be("too_complex");
    }

    [Fact(DisplayName = "Recherche globale — un lien de partage est refuse")]
    public async Task LinkCaller_IsDenied()
    {
        Func<Task> act = () => Handler().Handle(new SearchAllVaultsQuery("share:x", """{"text":"x"}"""), default);
        await act.Should().ThrowAsync<AccessDeniedException>();
    }
}
