// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Suppression d'un compte chez le fournisseur d'identite : l'API demande un
// jeton de service (audience Zitadel), puis supprime l'utilisateur. Un refus
// ou une panne arretent tout, avec un message clair.

using System.Net;
using FluentAssertions;
using Microsoft.Extensions.Options;
using NSubstitute;
using Savoire.Application.Indexer;
using Savoire.Domain.Exceptions;
using Savoire.Infrastructure.Auth;

namespace Savoire.Server.Unit.Tests.Auth;

public class ZitadelUserAdminTests
{
    private sealed class FakeIdp(Func<HttpRequestMessage, HttpResponseMessage> respond) : HttpMessageHandler
    {
        public List<(HttpMethod Method, string Url, string? Auth, string Body)> Calls { get; } = [];
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            string body = request.Content is null ? "" : await request.Content.ReadAsStringAsync(ct);
            Calls.Add((request.Method, request.RequestUri!.AbsoluteUri, request.Headers.Authorization?.ToString(), body));
            return respond(request);
        }
    }

    private static IOptionsMonitor<T> Monitor<T>(T value)
    {
        var monitor = Substitute.For<IOptionsMonitor<T>>();
        monitor.CurrentValue.Returns(value);
        return monitor;
    }

    private static (ZitadelUserAdmin Admin, FakeIdp Idp) Build(HttpStatusCode deleteStatus, bool configured = true, HttpStatusCode tokenStatus = HttpStatusCode.OK)
    {
        var idp = new FakeIdp(req => req.Method == HttpMethod.Post
            ? new HttpResponseMessage(tokenStatus) { Content = new StringContent("{\"access_token\":\"jeton-de-service\",\"expires_in\":300}") }
            : new HttpResponseMessage(deleteStatus) { Content = new StringContent("{}") });
        var factory = Substitute.For<IHttpClientFactory>();
        factory.CreateClient(Arg.Any<string>()).Returns(_ => new HttpClient(idp, disposeHandler: false));
        var oidc = new OidcOptions { Authority = "https://auth.test/", Audience = "projet" };
        var indexer = new IndexerOptions();
        if (configured)
        {
            indexer.Oidc.PeerSubject = "pair";
            indexer.Oidc.ClientId = "savoire-api";
            indexer.Oidc.ClientSecret = "secret";
            indexer.Oidc.TokenEndpoint = "https://auth.test/oauth/v2/token";
        }
        return (new ZitadelUserAdmin(factory, Monitor(oidc), Monitor(indexer)), idp);
    }

    [Fact(DisplayName = "Supprime l'utilisateur avec un jeton de service dont l'audience est Zitadel")]
    public async Task Deletes_WithServiceToken()
    {
        (ZitadelUserAdmin admin, FakeIdp idp) = Build(HttpStatusCode.OK);
        admin.Configured.Should().BeTrue();

        await admin.DeleteUserAsync("1234 5");

        idp.Calls.Should().HaveCount(2);
        idp.Calls[0].Url.Should().Be("https://auth.test/oauth/v2/token");
        idp.Calls[0].Auth.Should().StartWith("Basic ");
        idp.Calls[0].Body.Should().Contain("grant_type=client_credentials").And.Contain("zitadel%3Aaud");
        idp.Calls[1].Method.Should().Be(HttpMethod.Delete);
        idp.Calls[1].Url.Should().Be("https://auth.test/v2/users/1234%205");
        idp.Calls[1].Auth.Should().Be("Bearer jeton-de-service");
    }

    [Fact(DisplayName = "Compte deja absent chez le fournisseur : ce n'est pas une erreur")]
    public async Task AlreadyGone_IsFine()
    {
        (ZitadelUserAdmin admin, _) = Build(HttpStatusCode.NotFound);
        await admin.Invoking(a => a.DeleteUserAsync("u1")).Should().NotThrowAsync();
    }

    [Theory(DisplayName = "Refus ou panne du fournisseur : erreur claire, la suppression s'arrete")]
    [InlineData(HttpStatusCode.Forbidden, "zitadel-bootstrap")]
    [InlineData(HttpStatusCode.InternalServerError, "500")]
    public async Task Refusal_Throws(HttpStatusCode status, string expected)
    {
        (ZitadelUserAdmin admin, _) = Build(status);
        (await admin.Invoking(a => a.DeleteUserAsync("u1")).Should().ThrowAsync<IdentityProviderException>())
            .WithMessage($"*{expected}*");
    }

    [Fact(DisplayName = "Jeton de service refuse : erreur claire, aucune suppression tentee")]
    public async Task TokenRefused_Throws()
    {
        (ZitadelUserAdmin admin, FakeIdp idp) = Build(HttpStatusCode.OK, tokenStatus: HttpStatusCode.Unauthorized);
        await admin.Invoking(a => a.DeleteUserAsync("u1")).Should().ThrowAsync<IdentityProviderException>();
        idp.Calls.Should().ContainSingle();
    }

    [Fact(DisplayName = "Sans identifiants de service : non configure")]
    public void NotConfigured()
    {
        (ZitadelUserAdmin admin, _) = Build(HttpStatusCode.OK, configured: false);
        admin.Configured.Should().BeFalse();
    }
}
