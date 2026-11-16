// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Supprimer un compte chez le fournisseur d'identite (Zitadel, ADR-028).
//
// L'API s'y presente avec son compte de service (savoire-api, les memes
// identifiants que pour appeler le pair indexeur : Indexer:Oidc), et un jeton
// dont l'audience est Zitadel lui-meme. Ce compte doit y avoir le role qui
// permet de supprimer un utilisateur de l'organisation (ORG_USER_MANAGER,
// donne par deploy/compose/zitadel/bootstrap.mjs). Sans ce role, Zitadel
// refuse (403) et la suppression du compte s'arrete, sans rien effacer.
//
// Non configure (Auth:Oidc ou Indexer:Oidc absents : tests, installation
// sans fournisseur) : rien a faire ici.

using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;
using Savoire.Application.Abstractions;
using Savoire.Application.Indexer;
using Savoire.Domain.Exceptions;

namespace Savoire.Infrastructure.Auth;

public sealed class ZitadelUserAdmin(
    IHttpClientFactory httpClients,
    IOptionsMonitor<OidcOptions> oidc,
    IOptionsMonitor<IndexerOptions> indexer) : IIdentityProviderAdmin
{
    public const string HttpClientName = "savoire-idp-admin";
    /// <summary>Audience des API de Zitadel.</summary>
    private const string ZitadelScope = "openid urn:zitadel:iam:org:project:id:zitadel:aud";

    public bool Configured => oidc.CurrentValue.Enabled && indexer.CurrentValue.Oidc.Configured;

    public async Task DeleteUserAsync(string subject, CancellationToken ct = default)
    {
        try
        {
            await DeleteAsync(subject, ct);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException && !ct.IsCancellationRequested)
        {
            throw new IdentityProviderException("Le fournisseur d'identité ne répond pas. Rien n'a été effacé : réessayez plus tard.");
        }
    }

    private async Task DeleteAsync(string subject, CancellationToken ct)
    {
        string authority = oidc.CurrentValue.Authority!.TrimEnd('/');
        HttpClient http = httpClients.CreateClient(HttpClientName);
        string token = await ServiceTokenAsync(http, ct);

        using var request = new HttpRequestMessage(HttpMethod.Delete, $"{authority}/v2/users/{Uri.EscapeDataString(subject)}");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        using HttpResponseMessage response = await http.SendAsync(request, ct);
        // Deja supprime chez lui : c'est ce qu'on voulait.
        if (response.IsSuccessStatusCode || response.StatusCode == HttpStatusCode.NotFound) return;
        throw new IdentityProviderException(response.StatusCode == HttpStatusCode.Forbidden
            ? "Le fournisseur d'identité refuse la suppression : le compte de service de l'API n'en a pas le droit (relancer zitadel-bootstrap)."
            : $"Le fournisseur d'identité n'a pas supprimé le compte ({(int)response.StatusCode}). Rien n'a été effacé.");
    }

    private async Task<string> ServiceTokenAsync(HttpClient http, CancellationToken ct)
    {
        IndexerOidcOptions service = indexer.CurrentValue.Oidc;
        using var request = new HttpRequestMessage(HttpMethod.Post, service.TokenEndpoint)
        {
            Content = new FormUrlEncodedContent(new Dictionary<string, string>
            {
                ["grant_type"] = "client_credentials",
                ["scope"] = ZitadelScope,
            }),
        };
        string basic = Convert.ToBase64String(Encoding.UTF8.GetBytes(
            $"{Uri.EscapeDataString(service.ClientId!)}:{Uri.EscapeDataString(service.ClientSecret!)}"));
        request.Headers.Authorization = new AuthenticationHeaderValue("Basic", basic);
        using HttpResponseMessage response = await http.SendAsync(request, ct);
        if (!response.IsSuccessStatusCode)
            throw new IdentityProviderException($"Le fournisseur d'identité refuse le jeton de service ({(int)response.StatusCode}). Rien n'a été effacé.");
        using JsonDocument doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
        return doc.RootElement.GetProperty("access_token").GetString()
            ?? throw new IdentityProviderException("Le fournisseur d'identité n'a pas rendu de jeton. Rien n'a été effacé.");
    }
}
