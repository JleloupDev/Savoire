// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// L'auteur d'une modification relayee est donne par le serveur : un compte
// (son nom), ou un invite (lien de partage), jamais ce que dit le client.

using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using FluentAssertions;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.SignalR.Client;
using Savoire.Application.Common;

namespace Savoire.Server.Integration.Tests.Hubs;

[Collection("Integration")]
public class OperationAuthorTests : IClassFixture<AppFactory>
{
    private readonly AppFactory _factory;
    public OperationAuthorTests(AppFactory factory) => _factory = factory;

    private HubConnection Connect(string token) =>
        new HubConnectionBuilder()
            .WithUrl("http://localhost/hubs/sync", options =>
            {
                options.HttpMessageHandlerFactory = _ => _factory.Server.CreateHandler();
                options.Transports = HttpTransportType.LongPolling;
                options.AccessTokenProvider = () => Task.FromResult<string?>(token);
            })
            .Build();

    [Fact(DisplayName = "Operation relayee : l'auteur est le compte, ou « Invité » pour un lien de partage")]
    public async Task Author_IsStampedByServer()
    {
        string uid = Guid.NewGuid().ToString("N")[..8];
        (string ownerToken, string ownerId) = await _factory.CreateUserAndGetTokenAsync($"author-owner-{uid}@test.com", displayName: "Ana");
        (string memberToken, string memberId) = await _factory.CreateUserAndGetTokenAsync($"author-member-{uid}@test.com", displayName: "Bob");
        HttpClient owner = _factory.CreateClient();
        owner.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", ownerToken);
        string vaultId = (await (await owner.PostAsJsonAsync($"/api/v1/users/{ownerId}/vaults", new { name = "V" })).Content.ReadFromJsonAsync<VaultSummaryDto>())!.Id;
        (await owner.PostAsJsonAsync($"/api/v1/vaults/{vaultId}/members", new { userId = memberId, role = "editor" })).EnsureSuccessStatusCode();
        string docId = await _factory.NewDocumentAsync(ownerToken, vaultId);
        var link = await (await owner.PostAsJsonAsync($"/api/v1/documents/{docId}/sharing/links", new { permission = "write" })).Content.ReadFromJsonAsync<ShareLinkDto>();
        var access = await (await _factory.CreateClient().GetAsync($"/api/v1/share/{Uri.EscapeDataString(link!.Token)}/access")).Content.ReadFromJsonAsync<ShareLinkAccessDto>();

        await using var watcher = Connect(ownerToken);
        var authors = new List<JsonElement>();
        watcher.On<string, string, string, JsonElement>("ReceiveOperation", (_, _, _, author) => authors.Add(author));
        await watcher.StartAsync();
        await watcher.InvokeAsync("JoinDocument", vaultId, docId);

        await using var guest = Connect(access!.AccessToken);
        await guest.StartAsync();
        await guest.InvokeAsync("JoinDocument", vaultId, docId);
        await guest.InvokeAsync("PushOperation", vaultId, docId, "pretend-to-be-ana", Convert.ToBase64String(Encoding.UTF8.GetBytes("op")));

        await using var member = Connect(memberToken);
        await member.StartAsync();
        await member.InvokeAsync("JoinDocument", vaultId, docId);
        await member.InvokeAsync("PushOperation", vaultId, docId, "c", Convert.ToBase64String(Encoding.UTF8.GetBytes("op")));

        for (int i = 0; i < 60 && authors.Count < 2; i++) await Task.Delay(50);
        authors.Should().HaveCount(2);
        authors[0].GetProperty("name").GetString().Should().Be("Invité");
        authors[0].GetProperty("guest").GetBoolean().Should().BeTrue();
        authors[0].GetProperty("id").GetString().Should().StartWith("share:");
        authors[1].GetProperty("id").GetString().Should().Be(memberId);
        authors[1].GetProperty("name").GetString().Should().Be("Bob");
        authors[1].GetProperty("guest").GetBoolean().Should().BeFalse();
    }
}
