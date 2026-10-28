// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Compaction d'un canal d'index (VaultHub.SnapshotIndex, ADR-027 etape 8) :
// l'etat remplace exactement les trames que la connexion a recues a
// JoinIndex ; une trame arrivee depuis reste ; une seconde compaction des
// memes trames n'ecrit rien. Le serveur ne lit rien : octets opaques.
// L'egalite des etats Yjs apres compaction est verifiee cote client
// (infrastructure-sync-tests, IndexChannelCompaction.test.ts).

using System.Net.Http.Json;
using FluentAssertions;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using static Savoire.Server.Integration.Tests.Indexer.IndexerTestKit;

namespace Savoire.Server.Integration.Tests.Indexer;

[Collection("Integration")]
public class IndexChannelSnapshotTests : IClassFixture<AppFactory>, IAsyncLifetime
{
    private const string Ns = "metadata";
    private readonly AppFactory _factory;
    private string _token = null!;
    private string _readerToken = null!;
    private string _vaultId = null!;

    public IndexChannelSnapshotTests(AppFactory factory) => _factory = factory;

    public async Task InitializeAsync()
    {
        var uid = Guid.NewGuid().ToString("N")[..8];
        (_token, string userId) = await _factory.CreateUserAndGetTokenAsync($"idx-snap-{uid}@test.com");
        (_readerToken, string readerId) = await _factory.CreateUserAndGetTokenAsync($"idx-snap-r-{uid}@test.com");
        _vaultId = await _factory.NewVaultAsync(_token, userId);
        (await _factory.Client(_token).PostAsJsonAsync($"/api/v1/vaults/{_vaultId}/members", new { userId = readerId, role = "viewer" }))
            .EnsureSuccessStatusCode();
    }

    public Task DisposeAsync() => Task.CompletedTask;

    private async Task<string[]> JoinAsync(HubConnection conn) => await conn.InvokeAsync<string[]>("JoinIndex", _vaultId, Ns);

    [Fact(DisplayName = "SnapshotIndex — remplace les trames recues, garde celles arrivees depuis")]
    public async Task ReplacesOnlyReplayedOps()
    {
        await using HubConnection a = await _factory.HubAsync("/hubs/vault", _token);
        await using HubConnection b = await _factory.HubAsync("/hubs/vault", _token);
        foreach (byte i in new byte[] { 1, 2, 3 })
            await a.InvokeAsync("PushIndexUpdate", _vaultId, Ns, B64(i));

        (await JoinAsync(a)).Should().Equal(B64(1), B64(2), B64(3));
        await b.InvokeAsync("PushIndexUpdate", _vaultId, Ns, B64(4));
        await a.InvokeAsync("SnapshotIndex", _vaultId, Ns, B64(0xEE));

        await using HubConnection c = await _factory.HubAsync("/hubs/vault", _token);
        (await JoinAsync(c)).Should().BeEquivalentTo([B64(4), B64(0xEE)]);
    }

    [Fact(DisplayName = "SnapshotIndex — deux compactions des memes trames : la seconde n'ecrit rien")]
    public async Task ConcurrentSnapshots_DoNotStack()
    {
        await using HubConnection a = await _factory.HubAsync("/hubs/vault", _token);
        await using HubConnection d = await _factory.HubAsync("/hubs/vault", _token);
        foreach (byte i in new byte[] { 1, 2, 3 })
            await a.InvokeAsync("PushIndexUpdate", _vaultId, Ns, B64(i));
        await JoinAsync(a);
        await JoinAsync(d);

        await a.InvokeAsync("SnapshotIndex", _vaultId, Ns, B64(0xA0));
        await d.InvokeAsync("SnapshotIndex", _vaultId, Ns, B64(0xD0));

        await using HubConnection c = await _factory.HubAsync("/hubs/vault", _token);
        (await JoinAsync(c)).Should().Equal(B64(0xA0));
    }

    [Fact(DisplayName = "SnapshotIndex — sans JoinIndex sur la connexion : rien ne change")]
    public async Task WithoutJoin_NoOp()
    {
        await using HubConnection a = await _factory.HubAsync("/hubs/vault", _token);
        await a.InvokeAsync("PushIndexUpdate", _vaultId, Ns, B64(7));
        await a.InvokeAsync("SnapshotIndex", _vaultId, Ns, B64(0xEE));
        (await JoinAsync(a)).Should().Equal(B64(7));
    }

    [Fact(DisplayName = "SnapshotIndex — un lecteur ne peut pas compacter (memes droits que PushIndexUpdate)")]
    public async Task Reader_CannotSnapshot()
    {
        await using HubConnection owner = await _factory.HubAsync("/hubs/vault", _token);
        await owner.InvokeAsync("PushIndexUpdate", _vaultId, Ns, B64(5));
        await using HubConnection reader = await _factory.HubAsync("/hubs/vault", _readerToken);
        (await JoinAsync(reader)).Should().Equal(B64(5));

        Func<Task> act = () => reader.InvokeAsync("SnapshotIndex", _vaultId, Ns, B64(0xEE));
        await act.Should().ThrowAsync<HubException>();
        (await JoinAsync(owner)).Should().Equal(B64(5));
    }
}
