// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Le chemin d'un document partage par lien : donne a la creation du lien,
// rendu a la page du lien (elle en tire l'editeur : discussion, base...).

using System.Net.Http.Headers;
using System.Net.Http.Json;
using FluentAssertions;
using Savoire.Application.Common;

namespace Savoire.Server.Integration.Tests.Sharing;

[Collection("Integration")]
public class ShareLinkPathTests : IClassFixture<AppFactory>
{
    private readonly AppFactory _factory;
    public ShareLinkPathTests(AppFactory factory) => _factory = factory;

    [Theory(DisplayName = "Lien vers un document : le chemin donne a la creation revient a la page du lien")]
    [InlineData("Equipe/Point hebdo.chat", "Equipe/Point hebdo.chat")]
    [InlineData("../../etc/passwd", null)]
    [InlineData(null, null)]
    public async Task Path_RoundTrips(string? given, string? expected)
    {
        (string token, string userId) = await _factory.CreateUserAndGetTokenAsync($"path-{Guid.NewGuid():N}@test.com", displayName: "Owner");
        HttpClient owner = _factory.CreateClient();
        owner.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        string vaultId = (await (await owner.PostAsJsonAsync($"/api/v1/users/{userId}/vaults", new { name = "V" })).Content.ReadFromJsonAsync<VaultSummaryDto>())!.Id;
        string docId = await _factory.NewDocumentAsync(token, vaultId);

        var link = await (await owner.PostAsJsonAsync($"/api/v1/documents/{docId}/sharing/links", new { permission = "write", path = given }))
            .Content.ReadFromJsonAsync<ShareLinkDto>();
        var access = await (await _factory.CreateClient().GetAsync($"/api/v1/share/{Uri.EscapeDataString(link!.Token)}/access"))
            .Content.ReadFromJsonAsync<ShareLinkAccessDto>();

        access!.Path.Should().Be(expected);
        access.VaultId.Should().Be(vaultId);
    }
}
