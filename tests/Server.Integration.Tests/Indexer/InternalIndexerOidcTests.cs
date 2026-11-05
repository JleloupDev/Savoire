// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Le pair indexeur s'identifie chez le fournisseur d'identite (ADR-028) :
// un jeton au nom de son compte de service ouvre l'API interne ; celui d'une
// personne, non.

using System.Net;
using FluentAssertions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;

namespace Savoire.Server.Integration.Tests.Indexer;

public class OidcPeerAppFactory : IndexerAppFactory
{
    public const string PeerSubject = "indexer-peer-subject";

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        base.ConfigureWebHost(builder);
        builder.ConfigureAppConfiguration(config => config.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Indexer:Oidc:PeerSubject"] = PeerSubject,
        }));
    }
}

[Collection("Integration")]
public class InternalIndexerOidcTests(OidcPeerAppFactory factory) : IClassFixture<OidcPeerAppFactory>
{
    private const string Route = "/internal/indexer/vaults?instance=idx-a";

    [Fact(DisplayName = "API interne — jeton du fournisseur au nom du pair : 200")]
    public async Task PeerServiceAccount_IsAccepted()
    {
        string token = AppFactory.MintIdpToken(OidcPeerAppFactory.PeerSubject, email: null);
        var response = await factory.ServiceClient(token).GetAsync(Route);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact(DisplayName = "API interne — jeton du fournisseur d'une personne (meme admin) : 401")]
    public async Task PersonToken_IsRefused()
    {
        var response = await factory.ServiceClient(await factory.GetAdminTokenAsync()).GetAsync(Route);
        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact(DisplayName = "API interne — jeton du pair signe par un autre fournisseur : 401")]
    public async Task PeerSubject_FromAnotherIssuer_IsRefused()
    {
        string token = AppFactory.MintIdpToken(OidcPeerAppFactory.PeerSubject, email: null, issuer: "https://autre-idp.test");
        var response = await factory.ServiceClient(token).GetAsync(Route);
        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact(DisplayName = "API interne — le jeton partage reste accepte (tests, installation sans fournisseur)")]
    public async Task SharedToken_StillWorks()
    {
        var response = await factory.ServiceClient().GetAsync(Route);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }
}
