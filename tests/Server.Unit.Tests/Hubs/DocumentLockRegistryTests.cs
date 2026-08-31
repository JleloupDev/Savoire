// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using FluentAssertions;
using Savoire.Server.Hubs;
using Xunit;

namespace Savoire.Server.Unit.Tests.Hubs;

public class DocumentLockRegistryTests
{
    private static LockHolder Holder(string who) => new($"user-{who}", who, $"conn-{who}");

    [Fact(DisplayName = "Un verrou libre est accorde au demandeur")]
    public void Acquire_WhenFree_GrantsToCaller()
    {
        var reg = new DocumentLockRegistry();
        LockHolder h = reg.TryAcquire("v", "d", Holder("alice"));
        h.DisplayName.Should().Be("alice");
    }

    [Fact(DisplayName = "Un verrou deja pris n'est PAS vole : le second recoit le detenteur courant")]
    public void Acquire_WhenHeld_ReturnsExistingHolder()
    {
        var reg = new DocumentLockRegistry();
        reg.TryAcquire("v", "d", Holder("alice"));

        LockHolder h = reg.TryAcquire("v", "d", Holder("bob"));

        h.DisplayName.Should().Be("alice");
        h.ConnectionId.Should().Be("conn-alice");
    }

    [Fact(DisplayName = "Deux demandes vraiment concurrentes : un seul detenteur")]
    public void Acquire_Concurrent_YieldsSingleHolder()
    {
        var reg = new DocumentLockRegistry();
        var results = new LockHolder[64];

        Parallel.For(0, 64, i => { results[i] = reg.TryAcquire("v", "d", Holder($"u{i}")); });

        // Tous doivent voir LE MEME detenteur : c'est tout l'interet d'un
        // arbitrage central plutot que d'un accord entre pairs.
        results.Select(r => r.ConnectionId).Distinct().Should().HaveCount(1);
    }

    [Fact(DisplayName = "Seul le detenteur peut liberer")]
    public void Release_ByNonHolder_IsRefused()
    {
        var reg = new DocumentLockRegistry();
        reg.TryAcquire("v", "d", Holder("alice"));

        reg.Release("v", "d", "conn-bob").Should().BeFalse();
        reg.Get("v", "d")!.DisplayName.Should().Be("alice");

        reg.Release("v", "d", "conn-alice").Should().BeTrue();
        reg.Get("v", "d").Should().BeNull();
    }

    [Fact(DisplayName = "Une deconnexion libere tous les verrous de cette connexion")]
    public void ReleaseAllFor_FreesEverythingHeldByConnection()
    {
        var reg = new DocumentLockRegistry();
        reg.TryAcquire("v", "d1", Holder("alice"));
        reg.TryAcquire("v", "d2", Holder("alice"));
        reg.TryAcquire("v", "d3", Holder("bob"));

        var freed = reg.ReleaseAllFor("conn-alice");

        freed.Should().BeEquivalentTo(["v/d1", "v/d2"]);
        reg.Get("v", "d3").Should().NotBeNull("le verrou de bob ne doit pas bouger");
    }

    [Fact(DisplayName = "Les verrous sont cloisonnes par vault et par document")]
    public void Locks_AreScopedPerVaultAndDoc()
    {
        var reg = new DocumentLockRegistry();
        reg.TryAcquire("v1", "d", Holder("alice"));

        reg.TryAcquire("v2", "d", Holder("bob")).DisplayName.Should().Be("bob");
        reg.TryAcquire("v1", "autre", Holder("bob")).DisplayName.Should().Be("bob");
    }
}
