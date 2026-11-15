// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Comptes (revue du 14/11/2026, E1) : plus de liste publique. Un compte
// connecte retrouve un autre compte par son adresse exacte ou son
// identifiant ; personne d'autre, et pas a la chaine.

using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;
using Savoire.Application.Common;

namespace Savoire.Server.Integration.Tests.Users;

[Collection("Integration")]
public class UsersApiTests : IClassFixture<AppFactory>
{
    private readonly AppFactory _factory;
    public UsersApiTests(AppFactory factory) => _factory = factory;

    private HttpClient Authed(string token)
    {
        HttpClient c = _factory.CreateClient();
        c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return c;
    }

    private static string Uid() => Guid.NewGuid().ToString("N")[..8];

    [Theory(DisplayName = "Sans connexion : aucune route des comptes ne repond")]
    [InlineData("/api/v1/users")]
    [InlineData("/api/v1/users?email=quelquun@test.com")]
    [InlineData("/api/v1/users/un-identifiant")]
    public async Task Anonymous_IsRejected(string url)
    {
        (await _factory.CreateClient().GetAsync(url)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact(DisplayName = "Connecte : il n'existe pas de liste des comptes")]
    public async Task NoListing()
    {
        (string token, _) = await _factory.CreateUserAndGetTokenAsync($"users-list-{Uid()}@test.com", displayName: "Liste");
        var resp = await Authed(token).GetAsync("/api/v1/users");
        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await resp.Content.ReadAsStringAsync()).Should().NotContain("displayName");
    }

    [Fact(DisplayName = "Connecte : un compte se retrouve par son adresse exacte ou son identifiant, nom seulement")]
    public async Task LookupByEmailOrId()
    {
        string uid = Uid();
        (string token, _) = await _factory.CreateUserAndGetTokenAsync($"users-a-{uid}@test.com", displayName: "Alice");
        (_, string bobId) = await _factory.CreateUserAndGetTokenAsync($"users-b-{uid}@test.com", displayName: "Bob");
        HttpClient alice = Authed(token);

        var byEmail = await alice.GetAsync($"/api/v1/users?email=users-b-{uid}@test.com");
        byEmail.StatusCode.Should().Be(HttpStatusCode.OK);
        JsonElement dto = await byEmail.Content.ReadFromJsonAsync<JsonElement>();
        dto.GetProperty("id").GetString().Should().Be(bobId);
        dto.GetProperty("displayName").GetString().Should().Be("Bob");
        dto.EnumerateObject().Select(p => p.Name).Should().BeEquivalentTo("id", "displayName");

        (await alice.GetFromJsonAsync<UserDto>($"/api/v1/users/{bobId}"))!.DisplayName.Should().Be("Bob");
        (await alice.GetAsync($"/api/v1/users?email=personne-{uid}@test.com")).StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await alice.GetAsync($"/api/v1/users/inconnu-{uid}")).StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact(DisplayName = "Un lien de partage ne donne pas acces aux comptes")]
    public async Task ShareLink_IsForbidden()
    {
        string uid = Uid();
        (string token, string ownerId) = await _factory.CreateUserAndGetTokenAsync($"users-owner-{uid}@test.com", displayName: "Owner");
        HttpClient owner = Authed(token);
        var vault = await owner.PostAsJsonAsync($"/api/v1/users/{ownerId}/vaults", new { name = "Vault" });
        string vaultId = (await vault.Content.ReadFromJsonAsync<VaultSummaryDto>())!.Id;
        var link = await (await owner.PostAsJsonAsync($"/api/v1/vaults/{vaultId}/sharing/links", new { permission = "read" }))
            .Content.ReadFromJsonAsync<ShareLinkDto>();
        var access = await (await _factory.CreateClient().GetAsync($"/api/v1/share/{Uri.EscapeDataString(link!.Token)}/access"))
            .Content.ReadFromJsonAsync<ShareLinkAccessDto>();

        HttpClient viaLink = Authed(access!.AccessToken);
        (await viaLink.GetAsync($"/api/v1/users?email=users-owner-{uid}@test.com")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await viaLink.GetAsync($"/api/v1/users/{ownerId}")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact(DisplayName = "Un compte ne teste pas des adresses a la chaine (429)")]
    public async Task Lookup_IsRateLimited()
    {
        (string token, _) = await _factory.CreateUserAndGetTokenAsync($"users-rate-{Uid()}@test.com", displayName: "Rate");
        HttpClient client = Authed(token);
        var statuses = new List<HttpStatusCode>();
        for (int i = 0; i < 40; i++)
            statuses.Add((await client.GetAsync($"/api/v1/users?email=essai-{i}@test.com")).StatusCode);

        statuses.Take(20).Should().OnlyContain(s => s == HttpStatusCode.NotFound);
        statuses.Should().Contain(HttpStatusCode.TooManyRequests);
    }
}
