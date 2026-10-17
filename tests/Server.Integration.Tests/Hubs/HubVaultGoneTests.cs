// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Vault disparu pendant qu'il est ouvert.
//
// Le proprietaire supprime le vault, ou retire l'acces d'un membre : les hubs
// doivent le dire par un code stable (« vault-not-found »), pas par une
// « unexpected error ». Le client s'en sert pour fermer le vault au lieu de
// reessayer en boucle. Un document non inscrit garde un code distinct : le
// vault, lui, existe toujours.

using System.Net.Http.Headers;
using System.Net.Http.Json;
using FluentAssertions;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Savoire.Application.Common;

namespace Savoire.Server.Integration.Tests.Hubs;

[Collection("Integration")]
public class HubVaultGoneTests : IClassFixture<AppFactory>, IAsyncLifetime
{
    private const string VaultNotFound = "HubException: vault-not-found";
    private const string DocumentNotInVault = "HubException: document-not-in-vault";

    private readonly AppFactory _factory;
    private string _ownerToken = null!;
    private string _memberToken = null!;
    private string _memberId = null!;
    private string _vaultId = null!;
    private HttpClient _owner = null!;

    public HubVaultGoneTests(AppFactory factory) => _factory = factory;

    public async Task InitializeAsync()
    {
        var uid = Guid.NewGuid().ToString("N")[..8];
        (_ownerToken, var ownerId) = await _factory.CreateUserAndGetTokenAsync($"gone-owner-{uid}@test.com", displayName: "Owner");
        (_memberToken, _memberId) = await _factory.CreateUserAndGetTokenAsync($"gone-member-{uid}@test.com", displayName: "Member");

        _owner = _factory.CreateClient();
        _owner.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", _ownerToken);
        var vaultResp = await _owner.PostAsJsonAsync($"/api/v1/users/{ownerId}/vaults", new { name = "Vault partage" });
        vaultResp.EnsureSuccessStatusCode();
        _vaultId = (await vaultResp.Content.ReadFromJsonAsync<VaultSummaryDto>())!.Id;

        (await _owner.PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/sharing/permissions",
            new { subjectId = _memberId, permission = "write", expiresAt = (DateTime?)null }))
            .EnsureSuccessStatusCode();
    }

    public Task DisposeAsync() => Task.CompletedTask;

    private HubConnection Connect(string hub, string token) =>
        new HubConnectionBuilder()
            .WithUrl($"http://localhost/hubs/{hub}", options =>
            {
                options.HttpMessageHandlerFactory = _ => _factory.Server.CreateHandler();
                options.Transports = HttpTransportType.LongPolling;
                options.AccessTokenProvider = () => Task.FromResult<string?>(token);
            })
            .Build();

    private async Task DeleteVaultAsync() =>
        (await _owner.DeleteAsync($"/api/v1/vaults/{_vaultId}")).EnsureSuccessStatusCode();

    private async Task RevokeMemberAsync() =>
        (await _owner.DeleteAsync($"/api/v1/vaults/{_vaultId}/sharing/permissions/{_memberId}"))
            .EnsureSuccessStatusCode();

    [Fact(DisplayName = "VaultHub — un vault inexistant rend le code vault-not-found")]
    public async Task JoinVault_Unknown_ReturnsVaultNotFound()
    {
        await using var conn = Connect("vault", _ownerToken);
        await conn.StartAsync();
        var act = () => conn.InvokeAsync("JoinVault", Guid.NewGuid().ToString());
        (await act.Should().ThrowAsync<HubException>()).Which.Message.Should().Contain(VaultNotFound);
    }

    [Fact(DisplayName = "VaultHub — vault supprime pendant qu'il est ouvert : vault-not-found sur chaque appel")]
    public async Task VaultDeleted_WhileOpen_ReturnsVaultNotFound()
    {
        var docId = await _factory.NewDocumentAsync(_ownerToken, _vaultId);
        await using var vault = Connect("vault", _memberToken);
        await using var room = Connect("room", _memberToken);
        await using var sync = Connect("sync", _memberToken);
        await vault.StartAsync();
        await room.StartAsync();
        await sync.StartAsync();
        await vault.InvokeAsync("JoinVault", _vaultId);

        await DeleteVaultAsync();

        var join     = () => vault.InvokeAsync("JoinVault", _vaultId);
        var register = () => vault.InvokeAsync<string[]>("RegisterDocuments", _vaultId, new[] { Guid.NewGuid().ToString() });
        var index    = () => vault.InvokeAsync<string[]>("JoinIndex", _vaultId, "map/review");
        var enter    = () => room.InvokeAsync("JoinRoom", _vaultId, docId);
        var document = () => sync.InvokeAsync("JoinDocument", _vaultId, docId);
        (await join.Should().ThrowAsync<HubException>()).Which.Message.Should().Contain(VaultNotFound);
        (await register.Should().ThrowAsync<HubException>()).Which.Message.Should().Contain(VaultNotFound);
        (await index.Should().ThrowAsync<HubException>()).Which.Message.Should().Contain(VaultNotFound);
        // Le document etait inscrit dans un vault qui n'existe plus.
        (await enter.Should().ThrowAsync<HubException>()).Which.Message.Should().ContainAny(VaultNotFound, DocumentNotInVault);
        (await document.Should().ThrowAsync<HubException>()).Which.Message.Should().ContainAny(VaultNotFound, DocumentNotInVault);
    }

    [Fact(DisplayName = "VaultHub — acces retire pendant que le vault est ouvert : vault-not-found")]
    public async Task AccessRevoked_WhileOpen_ReturnsVaultNotFound()
    {
        var docId = await _factory.NewDocumentAsync(_ownerToken, _vaultId);
        await using var vault = Connect("vault", _memberToken);
        await using var room = Connect("room", _memberToken);
        await vault.StartAsync();
        await room.StartAsync();
        await vault.InvokeAsync("JoinVault", _vaultId);
        await room.InvokeAsync("JoinRoom", _vaultId, docId);

        await RevokeMemberAsync();

        var join     = () => vault.InvokeAsync("JoinVault", _vaultId);
        var register = () => vault.InvokeAsync<string[]>("RegisterDocuments", _vaultId, new[] { Guid.NewGuid().ToString() });
        var push     = () => room.InvokeAsync("PushSnapshot", _vaultId, docId, "{}");
        (await join.Should().ThrowAsync<HubException>()).Which.Message.Should().Contain(VaultNotFound);
        (await register.Should().ThrowAsync<HubException>()).Which.Message.Should().Contain(VaultNotFound);
        (await push.Should().ThrowAsync<HubException>()).Which.Message.Should().Contain(VaultNotFound);
    }

    [Fact(DisplayName = "VaultHub — suppression du vault : les membres connectes sont prevenus et leur verification echoue")]
    public async Task VaultDeleted_PushesAccessChanged()
    {
        await using var vault = Connect("vault", _memberToken);
        var changed = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        vault.On<string>("VaultAccessChanged", id => changed.TrySetResult(id));
        await vault.StartAsync();
        await vault.InvokeAsync("JoinVault", _vaultId);
        await vault.InvokeAsync("CheckVaultAccess", _vaultId);

        await DeleteVaultAsync();

        (await changed.Task.WaitAsync(TimeSpan.FromSeconds(5))).Should().Be(_vaultId);
        var check = () => vault.InvokeAsync("CheckVaultAccess", _vaultId);
        (await check.Should().ThrowAsync<HubException>()).Which.Message.Should().Contain(VaultNotFound);
    }

    [Fact(DisplayName = "VaultHub — acces retire : le membre connecte est prevenu et sa verification echoue")]
    public async Task AccessRevoked_PushesAccessChanged()
    {
        await using var vault = Connect("vault", _memberToken);
        var changed = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        vault.On<string>("VaultAccessChanged", id => changed.TrySetResult(id));
        await vault.StartAsync();
        await vault.InvokeAsync("JoinVault", _vaultId);

        await RevokeMemberAsync();

        (await changed.Task.WaitAsync(TimeSpan.FromSeconds(5))).Should().Be(_vaultId);
        var check = () => vault.InvokeAsync("CheckVaultAccess", _vaultId);
        (await check.Should().ThrowAsync<HubException>()).Which.Message.Should().Contain(VaultNotFound);
    }

    [Fact(DisplayName = "SyncHub — un document non inscrit a son propre code : le vault n'est pas perdu")]
    public async Task UnregisteredDocument_IsNotVaultNotFound()
    {
        await using var sync = Connect("sync", _ownerToken);
        await sync.StartAsync();
        var join = () => sync.InvokeAsync("JoinDocument", _vaultId, Guid.NewGuid().ToString());
        var error = (await join.Should().ThrowAsync<HubException>()).Which;
        error.Message.Should().Contain(DocumentNotInVault);
        error.Message.Should().NotContain(VaultNotFound);
    }

    [Fact(DisplayName = "VaultHub — un lecteur qui ecrit recoit access-denied, pas vault-not-found")]
    public async Task Viewer_Write_ReturnsAccessDenied()
    {
        (await _owner.PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/sharing/permissions",
            new { subjectId = _memberId, permission = "read", expiresAt = (DateTime?)null }))
            .EnsureSuccessStatusCode();
        await using var vault = Connect("vault", _memberToken);
        await vault.StartAsync();
        var register = () => vault.InvokeAsync<string[]>("RegisterDocuments", _vaultId, new[] { Guid.NewGuid().ToString() });
        (await register.Should().ThrowAsync<HubException>()).Which.Message.Should().Contain("HubException: access-denied");
    }
}
