// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Repartition des vaults entre instances du pair indexeur : hachage de
// rendez-vous FNV-1a 64 bits. Les memes vecteurs figurent dans
// docs/Architecture/indexer-protocol.md, pour que le cote Node verifie la
// meme fonction.

using FluentAssertions;
using Savoire.Application.Indexer;

namespace Savoire.Server.Unit.Tests.Indexer;

public class IndexerRoutingTests
{
    private static readonly IndexerInstanceOptions[] Three =
    [
        new() { Name = "idx-a", Url = "http://idx-a:7070" },
        new() { Name = "idx-b", Url = "http://idx-b:7070" },
        new() { Name = "idx-c", Url = "http://idx-c:7070" },
    ];

    [Theory(DisplayName = "FNV-1a 64 bits — vecteurs de reference")]
    [InlineData("", 0xcbf29ce484222325UL)]
    [InlineData("a", 0xaf63dc4c8601ec8cUL)]
    [InlineData("foobar", 0x85944171f73967e8UL)]
    public void Fnv1a64_MatchesReferenceVectors(string text, ulong expected) =>
        IndexerRouting.Fnv1a64(text).Should().Be(expected);

    [Theory(DisplayName = "Poids — FNV-1a de « name|vaultId »")]
    [InlineData("idx-a", "default", 0xbf6099b93275125fUL)]
    [InlineData("idx-b", "default", 0xbabf58d5c3c8d712UL)]
    [InlineData("idx-c", "default", 0x87b6a1c470f54ff5UL)]
    [InlineData("idx-b", "7c9e6679-7425-40de-944b-e07fc1f90ae7", 0x5a77b6682bd716c7UL)]
    [InlineData("idx-c", "d3b07384-d9a0-4c3b-9f7e-1a2b3c4d5e6f", 0xfc0ea165c6324b60UL)]
    public void Weight_IsFnvOfNameBarVaultId(string instance, string vaultId, ulong expected) =>
        IndexerRouting.Weight(instance, vaultId).Should().Be(expected);

    [Theory(DisplayName = "Proprietaire — 3 instances, vecteurs du protocole")]
    [InlineData("default", "idx-a")]
    [InlineData("3f2504e0-4f89-41d3-9a0c-0305e82c3301", "idx-a")]
    [InlineData("7c9e6679-7425-40de-944b-e07fc1f90ae7", "idx-b")]
    [InlineData("0b6f3c2e-9d61-4c1a-8b8e-2f1d5a7c9e40", "idx-a")]
    [InlineData("d3b07384-d9a0-4c3b-9f7e-1a2b3c4d5e6f", "idx-c")]
    [InlineData("a1b2c3d4-e5f6-4789-8abc-def012345678", "idx-c")]
    [InlineData("11111111-2222-4333-8444-555555555555", "idx-c")]
    [InlineData("ffffffff-ffff-4fff-bfff-ffffffffffff", "idx-b")]
    public void OwnerOf_MatchesProtocolVectors(string vaultId, string expectedOwner)
    {
        IndexerRouting.OwnerOf(vaultId, Three)!.Name.Should().Be(expectedOwner);
        IndexerRouting.IsOwner(expectedOwner, vaultId, Three).Should().BeTrue();
    }

    [Fact(DisplayName = "Proprietaire — independant de l'ordre de la liste")]
    public void OwnerOf_DoesNotDependOnOrder()
    {
        IndexerInstanceOptions[] reversed = [.. Three.Reverse()];
        for (int i = 0; i < 200; i++)
        {
            string vaultId = Guid.NewGuid().ToString();
            IndexerRouting.OwnerOf(vaultId, reversed)!.Name
                .Should().Be(IndexerRouting.OwnerOf(vaultId, Three)!.Name);
        }
    }

    [Fact(DisplayName = "Ajouter une instance ne deplace des vaults que vers elle (environ 1/n)")]
    public void AddingInstance_OnlyMovesVaultsToTheNewOne()
    {
        IndexerInstanceOptions[] four = [.. Three, new() { Name = "idx-d", Url = "http://idx-d:7070" }];
        int moved = 0;
        const int total = 2000;
        for (int i = 0; i < total; i++)
        {
            string vaultId = Guid.NewGuid().ToString();
            string before = IndexerRouting.OwnerOf(vaultId, Three)!.Name;
            string after = IndexerRouting.OwnerOf(vaultId, four)!.Name;
            if (after == before) continue;
            after.Should().Be("idx-d");
            moved++;
        }
        // Attendu : environ un quart.
        moved.Should().BeInRange(total / 4 - total / 10, total / 4 + total / 10);
    }

    [Fact(DisplayName = "Aucune instance : aucun proprietaire")]
    public void OwnerOf_NoInstance_IsNull() =>
        IndexerRouting.OwnerOf("default", []).Should().BeNull();
}
