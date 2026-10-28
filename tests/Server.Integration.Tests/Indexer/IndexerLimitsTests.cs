// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Pair indexeur desactive (pas de jeton : pas d'API interne, routes publiques
// en 503) et limitation de debit (429 + Retry-After).

using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;
using FluentAssertions;

namespace Savoire.Server.Integration.Tests.Indexer;

[Collection("Integration")]
public class IndexerDisabledTests : IClassFixture<AppFactory>
{
    private readonly AppFactory _factory;
    public IndexerDisabledTests(AppFactory factory) => _factory = factory;

    [Fact(DisplayName = "Desactive — l'API interne n'existe pas (404), meme avec un jeton")]
    public async Task InternalApi_Is404()
    {
        HttpClient client = _factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new("Bearer", IndexerAppFactory.ServiceToken);
        (await client.GetAsync("/internal/indexer/vaults?instance=idx-a")).StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await client.GetAsync("/internal/indexer/changes?instance=idx-a")).StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact(DisplayName = "Desactive — routes publiques en 503 + Retry-After ; le reglage reste lisible")]
    public async Task PublicRoutes_Are503()
    {
        var uid = Guid.NewGuid().ToString("N")[..8];
        (string token, string userId) = await _factory.CreateUserAndGetTokenAsync($"idx-off-{uid}@test.com");
        string vaultId = await _factory.NewVaultAsync(token, userId);
        HttpClient client = _factory.Client(token);

        var call = await client.PostAsync($"/api/v1/vaults/{vaultId}/index/tags/list", new StringContent("{}", Encoding.UTF8, "application/json"));
        call.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        call.Headers.RetryAfter.Should().NotBeNull();

        var search = await client.PostAsync("/api/v1/search", new StringContent("""{"text":"x"}""", Encoding.UTF8, "application/json"));
        search.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        search.Headers.RetryAfter.Should().NotBeNull();

        var setting = await client.GetFromJsonAsync<JsonObject>($"/api/v1/vaults/{vaultId}/indexer");
        setting!["mode"]!.GetValue<string>().Should().Be("managed");
        setting["state"]!["status"]!.GetValue<string>().Should().Be("unavailable");
    }
}

/// <summary>Trois appels par minute et par personne.</summary>
public sealed class UserLimitedIndexerAppFactory : IndexerAppFactory
{
    protected override int PerUserPerMinute => 3;
}

/// <summary>Quatre appels par minute et par vault.</summary>
public sealed class VaultLimitedIndexerAppFactory : IndexerAppFactory
{
    protected override int PerVaultPerMinute => 4;
}

[Collection("Integration")]
public class IndexerUserRateLimitTests : IClassFixture<UserLimitedIndexerAppFactory>
{
    private readonly UserLimitedIndexerAppFactory _factory;
    public IndexerUserRateLimitTests(UserLimitedIndexerAppFactory factory) => _factory = factory;

    [Fact(DisplayName = "Debit — par personne : 429 + Retry-After au-dela de la limite")]
    public async Task PerUser_429()
    {
        (string token, string userId) = await _factory.CreateUserAndGetTokenAsync($"idx-rl-{Guid.NewGuid():N}@test.com");
        string vaultId = await _factory.NewVaultAsync(token, userId);
        HttpClient client = _factory.Client(token);

        var statuses = new List<HttpResponseMessage>();
        for (int i = 0; i < 8; i++)
            statuses.Add(await client.PostAsync($"/api/v1/vaults/{vaultId}/index/tags/list",
                new StringContent("{}", Encoding.UTF8, "application/json")));

        statuses.Take(3).Should().OnlyContain(r => r.StatusCode == HttpStatusCode.OK);
        HttpResponseMessage limited = statuses.Last();
        limited.StatusCode.Should().Be(HttpStatusCode.TooManyRequests);
        limited.Headers.RetryAfter!.Delta!.Value.TotalSeconds.Should().BeGreaterThan(0);
        (await limited.Content.ReadFromJsonAsync<JsonObject>())!["error"]!["code"]!.GetValue<string>().Should().Be("rate_limited");

        // Une autre personne n'est pas freinee par la premiere.
        (string other, _) = await _factory.CreateUserAndGetTokenAsync($"idx-rl2-{Guid.NewGuid():N}@test.com");
        (await _factory.Client(other).PostAsync("/api/v1/search", new StringContent("""{"text":"x"}""", Encoding.UTF8, "application/json")))
            .StatusCode.Should().NotBe(HttpStatusCode.TooManyRequests);
    }
}

[Collection("Integration")]
public class IndexerVaultRateLimitTests : IClassFixture<VaultLimitedIndexerAppFactory>
{
    private readonly VaultLimitedIndexerAppFactory _factory;
    public IndexerVaultRateLimitTests(VaultLimitedIndexerAppFactory factory) => _factory = factory;

    [Fact(DisplayName = "Debit — par vault : plusieurs personnes sur le meme vault partagent la limite")]
    public async Task PerVault_429()
    {
        (string owner, string ownerId) = await _factory.CreateUserAndGetTokenAsync($"idx-vl-{Guid.NewGuid():N}@test.com");
        (string reader, string readerId) = await _factory.CreateUserAndGetTokenAsync($"idx-vl2-{Guid.NewGuid():N}@test.com");
        string vaultId = await _factory.NewVaultAsync(owner, ownerId);
        (await _factory.Client(owner).PostAsJsonAsync($"/api/v1/vaults/{vaultId}/members", new { userId = readerId, role = "viewer" }))
            .EnsureSuccessStatusCode();

        var statuses = new List<HttpStatusCode>();
        for (int i = 0; i < 8; i++)
        {
            HttpClient client = _factory.Client(i % 2 == 0 ? owner : reader);
            statuses.Add((await client.PostAsync($"/api/v1/vaults/{vaultId}/index/tags/list",
                new StringContent("{}", Encoding.UTF8, "application/json"))).StatusCode);
        }
        statuses.Take(4).Should().OnlyContain(s => s == HttpStatusCode.OK);
        statuses.Last().Should().Be(HttpStatusCode.TooManyRequests);
    }
}
