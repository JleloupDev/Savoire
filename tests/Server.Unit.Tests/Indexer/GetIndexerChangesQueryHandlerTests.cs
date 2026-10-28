// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Flux de changements filtre par instance : ordre, « last », limite,
// vaults hors du pair gere, vaults supprimes.

using FluentAssertions;
using NSubstitute;
using Savoire.Application.Indexer;
using Savoire.Application.Indexer.Internal;
using Savoire.Domain.Enums;
using Savoire.Domain.ReadModels;
using Savoire.Domain.Repositories;
using static Savoire.Server.Unit.Tests.Indexer.IndexerTestDoubles;

namespace Savoire.Server.Unit.Tests.Indexer;

public class GetIndexerChangesQueryHandlerTests
{
    // Proprietaires parmi idx-a, idx-b, idx-c (vecteurs du protocole).
    private const string OnA = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
    private const string OnB = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    private const string OnC = "d3b07384-d9a0-4c3b-9f7e-1a2b3c4d5e6f";

    private readonly IIndexerChangeRepository _changes = Substitute.For<IIndexerChangeRepository>();
    private readonly List<IndexerChange> _feed = [];

    public GetIndexerChangesQueryHandlerTests()
    {
        _changes.GetEpochAsync(Arg.Any<CancellationToken>()).Returns("epoch-1");
        _changes.GetSinceAsync(Arg.Any<long>(), Arg.Any<int>(), Arg.Any<CancellationToken>())
            .Returns(ci => (IReadOnlyList<IndexerChange>)_feed
                .Where(c => c.Seq > ci.ArgAt<long>(0)).OrderBy(c => c.Seq).Take(ci.ArgAt<int>(1)).ToList());
    }

    private GetIndexerChangesQueryHandler Handler(params VaultIndexerSetting[] settings) =>
        new(Monitor(Options("idx-a", "idx-b", "idx-c")), _changes, Settings(settings));

    private void Add(long seq, string vaultId, string kind = IndexerChangeKind.Document, string? docId = "d") =>
        _feed.Add(new IndexerChange(seq, vaultId, kind, kind == IndexerChangeKind.Document ? docId : null));

    [Fact(DisplayName = "Flux — seulement les vaults de l'instance, dans l'ordre ; last = plus grande sequence examinee")]
    public async Task FiltersByInstance_InOrder()
    {
        Add(1, OnA, docId: "a1"); Add(2, OnB); Add(3, OnA, IndexerChangeKind.Vault); Add(4, OnC); Add(5, OnB);

        IndexerChangesDto result = await Handler().Handle(new GetIndexerChangesQuery("idx-a", 0, null), default);

        result.Changes.Select(c => c.Seq).Should().Equal(1, 3);
        result.Changes[0].DocId.Should().Be("a1");
        result.Changes[1].Kind.Should().Be("vault");
        result.Changes[1].DocId.Should().BeNull();
        result.Last.Should().Be(5);
        result.Epoch.Should().Be("epoch-1");
    }

    [Fact(DisplayName = "Flux — last avance meme si aucune ligne ne concerne l'instance")]
    public async Task LastAdvances_WithoutMatches()
    {
        Add(10, OnB); Add(11, OnC);

        IndexerChangesDto result = await Handler().Handle(new GetIndexerChangesQuery("idx-a", 9, null), default);

        result.Changes.Should().BeEmpty();
        result.Last.Should().Be(11);
    }

    [Fact(DisplayName = "Flux — rien de neuf : last = since")]
    public async Task NothingNew_LastIsSince()
    {
        Add(3, OnA);
        IndexerChangesDto result = await Handler().Handle(new GetIndexerChangesQuery("idx-a", 3, null), default);
        result.Changes.Should().BeEmpty();
        result.Last.Should().Be(3);
    }

    [Fact(DisplayName = "Flux — limit atteinte : last = sequence de la derniere ligne rendue")]
    public async Task Limit_StopsAtLastReturned()
    {
        for (int i = 1; i <= 10; i++) Add(i, i % 2 == 0 ? OnA : OnB, docId: $"d{i}");

        IndexerChangesDto result = await Handler().Handle(new GetIndexerChangesQuery("idx-a", 0, 3), default);

        result.Changes.Select(c => c.Seq).Should().Equal(2, 4, 6);
        result.Last.Should().Be(6);
    }

    [Fact(DisplayName = "Flux — limit bornee a 2000, 500 par defaut")]
    public async Task Limit_IsClamped()
    {
        for (int i = 1; i <= 2600; i++) Add(i, OnA, docId: $"d{i}");

        (await Handler().Handle(new GetIndexerChangesQuery("idx-a", 0, null), default)).Changes.Should().HaveCount(500);
        (await Handler().Handle(new GetIndexerChangesQuery("idx-a", 0, 10_000), default)).Changes.Should().HaveCount(2000);
    }

    [Fact(DisplayName = "Flux — vault hors du pair gere : ses changements sont filtres, sa sortie (vault-deleted) passe")]
    public async Task NonManagedVault_IsFiltered_ButDeletionPasses()
    {
        Add(1, OnA, docId: "a1"); Add(2, OnA, IndexerChangeKind.VaultDeleted);

        IndexerChangesDto result = await Handler(Mode(OnA, IndexerMode.None))
            .Handle(new GetIndexerChangesQuery("idx-a", 0, null), default);

        result.Changes.Should().ContainSingle().Which.Kind.Should().Be("vault-deleted");
        result.Last.Should().Be(2);
    }
}
