// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Effacement (revue du 14/11/2026, E2) : supprimer un vault ou un compte
// efface tout ce qui est a lui, en base et sur le disque, et rien d'autre.

using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;
using FluentAssertions;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Savoire.Application.Abstractions;
using Savoire.Application.Common;
using Savoire.Domain.Exceptions;
using Savoire.Infrastructure.Persistence;

namespace Savoire.Server.Integration.Tests.Vaults;

[Collection("Integration")]
public class ErasureTests : IClassFixture<AppFactory>
{
    private readonly AppFactory _factory;
    public ErasureTests(AppFactory factory) => _factory = factory;

    private static string Uid() => Guid.NewGuid().ToString("N")[..8];
    private static string B64(string s) => Convert.ToBase64String(Encoding.UTF8.GetBytes(s));

    private HttpClient Authed(string token, AppFactory? factory = null)
    {
        HttpClient c = (factory ?? _factory).CreateClient();
        c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return c;
    }

    private HubConnection Connect(string hub, string token) =>
        new HubConnectionBuilder()
            .WithUrl($"http://localhost/hubs/{hub}", options =>
            {
                options.HttpMessageHandlerFactory = _ => _factory.Server.CreateHandler();
                options.Transports = HttpTransportType.LongPolling;
                options.AccessTokenProvider = () => Task.FromResult<string?>(token);
            })
            .Build();

    private async Task<T> DbAsync<T>(Func<AppDbContext, Task<T>> query)
    {
        using IServiceScope scope = _factory.Services.CreateScope();
        return await query(scope.ServiceProvider.GetRequiredService<AppDbContext>());
    }

    /// <summary>Operations du journal qui contiennent ce texte (le contenu d'une note).</summary>
    private Task<int> OpsContainingAsync(string marker)
    {
        byte[] needle = Encoding.UTF8.GetBytes(marker);
        return DbAsync(async db => (await db.Operations.AsNoTracking().Select(o => o.OpBytes).ToListAsync())
            .Count(b => b.AsSpan().IndexOf(needle) >= 0));
    }

    private sealed record Filled(string VaultId, string DocId, string Marker, string FilePath, string LinkToken, string Slug);

    /// <summary>Un vault avec de tout : repertoire, index, note, dessin, fichier, lien, page publiee, droit donne.</summary>
    private async Task<Filled> FilledVaultAsync(string token, string ownerId, string? guestId = null)
    {
        HttpClient owner = Authed(token);
        string marker = "contenu-" + Uid();
        var created = await owner.PostAsJsonAsync($"/api/v1/users/{ownerId}/vaults", new { name = "Vault " + marker });
        string vaultId = (await created.Content.ReadFromJsonAsync<VaultSummaryDto>())!.Id;
        string docId = await _factory.NewDocumentAsync(token, vaultId);

        await using (var vault = Connect("vault", token))
        await using (var sync = Connect("sync", token))
        await using (var room = Connect("room", token))
        {
            await vault.StartAsync(); await sync.StartAsync(); await room.StartAsync();
            await vault.InvokeAsync("JoinVault", vaultId);
            await vault.InvokeAsync("PushVaultOperation", vaultId, B64("repertoire-" + marker));
            await vault.InvokeAsync<string[]>("JoinIndex", vaultId, "metadata");
            await vault.InvokeAsync("PushIndexUpdate", vaultId, "metadata", B64("index-" + marker));
            await sync.InvokeAsync("JoinDocument", vaultId, docId);
            await sync.InvokeAsync("PushOperation", vaultId, docId, "c", B64("note-" + marker));
            await room.InvokeAsync("JoinRoom", vaultId, docId);
            await room.InvokeAsync("PushSnapshot", vaultId, docId, "{\"dessin\":\"" + marker + "\"}");
        }

        using var form = new MultipartFormDataContent { { new ByteArrayContent(Encoding.UTF8.GetBytes("fichier " + marker)), "file", "a.txt" } };
        var upload = await owner.PostAsync($"/api/v1/vaults/{vaultId}/attachments", form);
        upload.EnsureSuccessStatusCode();
        string filePath = (await upload.Content.ReadFromJsonAsync<JsonObject>())!["path"]!.GetValue<string>();

        var link = await (await owner.PostAsJsonAsync($"/api/v1/documents/{docId}/sharing/links", new { permission = "read" }))
            .Content.ReadFromJsonAsync<ShareLinkDto>();
        (await owner.PostAsJsonAsync($"/api/v1/vaults/{vaultId}/sharing/links", new { permission = "read" })).EnsureSuccessStatusCode();
        var published = await owner.PutAsJsonAsync($"/api/v1/vaults/{vaultId}/documents/{docId}/publication",
            new { title = "Page " + marker, description = "", html = "<p>" + marker + "</p>", indexable = false });
        published.EnsureSuccessStatusCode();
        string slug = (await published.Content.ReadFromJsonAsync<JsonObject>())!["slug"]!.GetValue<string>();
        if (guestId is not null)
            (await owner.PostAsJsonAsync($"/api/v1/vaults/{vaultId}/members", new { userId = guestId, role = "editor" })).EnsureSuccessStatusCode();
        return new Filled(vaultId, docId, marker, filePath, link!.Token, slug);
    }

    private string VaultFolder(string vaultId) => Path.Combine(_factory.TempStoragePath, vaultId);

    private async Task AssertErasedAsync(Filled v)
    {
        (await OpsContainingAsync(v.Marker)).Should().Be(0, "le journal ne garde rien du vault (repertoire, index, note, dessin)");
        (await DbAsync(db => db.ShareLinks.CountAsync(l => l.ResourceId == v.VaultId || l.ResourceId == v.DocId))).Should().Be(0);
        (await DbAsync(db => db.ResourcePermissions.CountAsync(p => p.ResourceId == v.VaultId || p.ResourceId == v.DocId))).Should().Be(0);
        (await DbAsync(db => db.Publications.CountAsync(p => p.VaultId == v.VaultId))).Should().Be(0);
        (await DbAsync(db => db.VaultDocuments.CountAsync(d => d.VaultId == v.VaultId))).Should().Be(0);
        (await DbAsync(db => db.VaultMembers.CountAsync(m => m.VaultId == v.VaultId))).Should().Be(0);
        Directory.Exists(VaultFolder(v.VaultId)).Should().BeFalse("les fichiers du vault sont effaces du disque");
        (await _factory.CreateClient().GetAsync($"/p/{v.Slug}")).StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await _factory.CreateClient().GetAsync($"/api/v1/share/{Uri.EscapeDataString(v.LinkToken)}/access")).StatusCode
            .Should().Be(HttpStatusCode.Forbidden);
    }

    private async Task AssertIntactAsync(Filled v)
    {
        (await OpsContainingAsync(v.Marker)).Should().Be(4);
        (await DbAsync(db => db.ShareLinks.CountAsync(l => l.ResourceId == v.VaultId || l.ResourceId == v.DocId))).Should().Be(2);
        (await DbAsync(db => db.Publications.CountAsync(p => p.VaultId == v.VaultId))).Should().Be(1);
        Directory.Exists(VaultFolder(v.VaultId)).Should().BeTrue();
    }

    // ── Supprimer un vault ───────────────────────────────────────────────────

    [Fact(DisplayName = "Supprimer un vault efface son contenu, en base et sur le disque, et pas celui des autres")]
    public async Task DeleteVault_ErasesEverything()
    {
        (string token, string ownerId) = await _factory.CreateUserAndGetTokenAsync($"erase-owner-{Uid()}@test.com", displayName: "Owner");
        Filled gone = await FilledVaultAsync(token, ownerId);
        Filled kept = await FilledVaultAsync(token, ownerId);
        await AssertIntactAsync(gone);

        (await Authed(token).DeleteAsync($"/api/v1/vaults/{gone.VaultId}")).StatusCode.Should().Be(HttpStatusCode.NoContent);

        await AssertErasedAsync(gone);
        await AssertIntactAsync(kept);
    }

    [Fact(DisplayName = "Supprimer un vault : un jeton personnel limite a lui est revoque, les autres le perdent")]
    public async Task DeleteVault_UpdatesAccessTokens()
    {
        (string token, string ownerId) = await _factory.CreateUserAndGetTokenAsync($"erase-tok-{Uid()}@test.com", displayName: "Owner");
        HttpClient owner = Authed(token);
        async Task<string> Vault(string name) =>
            (await (await owner.PostAsJsonAsync($"/api/v1/users/{ownerId}/vaults", new { name })).Content.ReadFromJsonAsync<VaultSummaryDto>())!.Id;
        string gone = await Vault("A effacer"), kept = await Vault("A garder");
        async Task<string> Token(params string[] vaultIds) =>
            (await (await owner.PostAsJsonAsync("/api/v1/me/access-tokens", new { name = "t", vaultIds })).Content.ReadFromJsonAsync<JsonObject>())!["info"]!["id"]!.GetValue<string>();
        string onlyGone = await Token(gone), both = await Token(gone, kept);

        (await owner.DeleteAsync($"/api/v1/vaults/{gone}")).StatusCode.Should().Be(HttpStatusCode.NoContent);

        var tokens = await DbAsync(db => db.AccessTokens.AsNoTracking().Where(t => t.Id == onlyGone || t.Id == both).ToListAsync());
        tokens.Single(t => t.Id == onlyGone).RevokedAt.Should().NotBeNull("une liste vide voudrait dire « tous les vaults »");
        tokens.Single(t => t.Id == both).VaultIds.Should().Be(kept);
        tokens.Single(t => t.Id == both).RevokedAt.Should().BeNull();
    }

    // ── Restes des suppressions d'avant ──────────────────────────────────────

    [Fact(DisplayName = "Purge des restes : compte d'abord, efface sur demande, reservee a l'administrateur")]
    public async Task OrphanPurge()
    {
        string marker = "orphelin-" + Uid(), ghostVault = "vault-fantome-" + Uid();
        await DbAsync(async db =>
        {
            DateTime now = DateTime.UtcNow;
            db.Operations.Add(new OperationEntity { Id = Guid.NewGuid().ToString(), ResourceType = "document", ResourceId = "doc-" + marker, ClientId = "c", ProducedAt = now, ReceivedAt = now, OpBytes = Encoding.UTF8.GetBytes(marker) });
            db.Operations.Add(new OperationEntity { Id = Guid.NewGuid().ToString(), ResourceType = "vault", ResourceId = "vault:" + ghostVault, ClientId = "c", ProducedAt = now, ReceivedAt = now, OpBytes = Encoding.UTF8.GetBytes(marker) });
            db.Operations.Add(new OperationEntity { Id = Guid.NewGuid().ToString(), ResourceType = "index", ResourceId = $"index:{ghostVault}:metadata", ClientId = "c", ProducedAt = now, ReceivedAt = now, OpBytes = Encoding.UTF8.GetBytes(marker) });
            db.Publications.Add(new PublicationEntity { Slug = "page-" + marker, VaultId = ghostVault, DocumentId = "doc-" + marker, Title = "t", Description = "", Html = marker, CreatedBy = "x", CreatedAt = now, UpdatedAt = now });
            return await db.SaveChangesAsync();
        });
        Directory.CreateDirectory(Path.Combine(VaultFolder(ghostVault), "attachments"));
        await File.WriteAllTextAsync(Path.Combine(VaultFolder(ghostVault), "attachments", "reste.txt"), marker);
        (string token, string ownerId) = await _factory.CreateUserAndGetTokenAsync($"erase-purge-{Uid()}@test.com", displayName: "Owner");
        Filled live = await FilledVaultAsync(token, ownerId);

        (await Authed(token).PostAsync("/api/v1/admin/orphans/purge", null)).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        HttpClient admin = await _factory.CreateAdminClientAsync();

        JsonObject dry = (await (await admin.PostAsync("/api/v1/admin/orphans/purge", null)).Content.ReadFromJsonAsync<JsonObject>())!;
        dry["dryRun"]!.GetValue<bool>().Should().BeTrue();
        dry["rows"]!["operations"]!.GetValue<long>().Should().BeGreaterThanOrEqualTo(3);
        dry["rows"]!["publications"]!.GetValue<long>().Should().BeGreaterThanOrEqualTo(1);
        dry["fileFolders"]!.GetValue<int>().Should().BeGreaterThanOrEqualTo(1);
        (await OpsContainingAsync(marker)).Should().Be(3, "compter n'efface rien");

        JsonObject done = (await (await admin.PostAsync("/api/v1/admin/orphans/purge?dryRun=false", null)).Content.ReadFromJsonAsync<JsonObject>())!;
        done["dryRun"]!.GetValue<bool>().Should().BeFalse();
        (await OpsContainingAsync(marker)).Should().Be(0);
        (await DbAsync(db => db.Publications.CountAsync(p => p.VaultId == ghostVault))).Should().Be(0);
        Directory.Exists(VaultFolder(ghostVault)).Should().BeFalse();
        await AssertIntactAsync(live);
    }

    // ── Supprimer un compte ──────────────────────────────────────────────────

    [Fact(DisplayName = "Supprimer son compte : confirmation exigee, puis tout ce qui est a soi part, rien de plus")]
    public async Task DeleteMyAccount()
    {
        string uid = Uid();
        (string token, string userId) = await _factory.CreateUserAndGetTokenAsync($"erase-me-{uid}@test.com", displayName: "Partante");
        (string otherToken, string otherId) = await _factory.CreateUserAndGetTokenAsync($"erase-other-{uid}@test.com", displayName: "Restante");
        Filled mine = await FilledVaultAsync(token, userId, guestId: otherId);
        Filled theirs = await FilledVaultAsync(otherToken, otherId, guestId: userId);
        (await Authed(token).PostAsJsonAsync("/api/v1/me/access-tokens", new { name = "t" })).EnsureSuccessStatusCode();
        HttpClient me = Authed(token);

        // Sans la confirmation : rien ne se passe.
        var noConfirm = await me.SendAsync(new HttpRequestMessage(HttpMethod.Delete, "/api/v1/auth/me") { Content = JsonContent.Create(new { confirm = "oui" }) });
        noConfirm.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        await AssertIntactAsync(mine);

        var deleted = await me.SendAsync(new HttpRequestMessage(HttpMethod.Delete, "/api/v1/auth/me") { Content = JsonContent.Create(new { confirm = "SUPPRIMER" }) });
        deleted.StatusCode.Should().Be(HttpStatusCode.NoContent);

        await AssertErasedAsync(mine);
        await AssertIntactAsync(theirs);
        (await DbAsync(db => db.Users.CountAsync(u => u.Id == userId))).Should().Be(0);
        (await DbAsync(db => db.VaultMembers.CountAsync(m => m.UserId == userId))).Should().Be(0);
        (await DbAsync(db => db.ResourcePermissions.CountAsync(p => p.SubjectId == userId))).Should().Be(0);
        (await DbAsync(db => db.AccessTokens.CountAsync(t => t.UserId == userId))).Should().Be(0);
        // Son jeton, encore valide chez le fournisseur d'identite, ne recree pas le compte.
        (await me.GetAsync("/api/v1/auth/me")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await DbAsync(db => db.Users.CountAsync(u => u.Id == userId))).Should().Be(0);
        // L'autre compte ne la retrouve plus, et garde son vault.
        (await Authed(otherToken).GetAsync($"/api/v1/users?email=erase-me-{uid}@test.com")).StatusCode.Should().Be(HttpStatusCode.NotFound);
        var workspace = await Authed(otherToken).GetFromJsonAsync<WorkspaceDto>($"/api/v1/users/{otherId}/vaults");
        workspace!.Vaults.Select(v => v.Id).Should().Contain(theirs.VaultId).And.NotContain(mine.VaultId);
    }

    [Fact(DisplayName = "Un administrateur supprime un compte ; un autre compte ne le peut pas")]
    public async Task AdminDeletesAccount()
    {
        string uid = Uid();
        (string token, string userId) = await _factory.CreateUserAndGetTokenAsync($"erase-adm-{uid}@test.com", displayName: "Visee");
        (string otherToken, _) = await _factory.CreateUserAndGetTokenAsync($"erase-adm2-{uid}@test.com", displayName: "Autre");
        Filled vault = await FilledVaultAsync(token, userId);

        (await Authed(otherToken).DeleteAsync($"/api/v1/admin/users/{userId}")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        await AssertIntactAsync(vault);

        HttpClient admin = await _factory.CreateAdminClientAsync();
        (await admin.DeleteAsync($"/api/v1/admin/users/{userId}")).StatusCode.Should().Be(HttpStatusCode.NoContent);
        await AssertErasedAsync(vault);
        (await admin.DeleteAsync($"/api/v1/admin/users/{userId}")).StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    private sealed class RefusingIdentityProvider : IIdentityProviderAdmin
    {
        public bool Configured => true;
        public Task DeleteUserAsync(string subject, CancellationToken ct = default) =>
            throw new IdentityProviderException("Le fournisseur d'identité refuse.");
    }

    [Fact(DisplayName = "Le fournisseur d'identite refuse : rien n'est efface")]
    public async Task IdentityProviderRefuses_NothingIsErased()
    {
        (string token, string userId) = await _factory.CreateUserAndGetTokenAsync($"erase-idp-{Uid()}@test.com", displayName: "Reste");
        Filled vault = await FilledVaultAsync(token, userId);
        using var refusing = _factory.WithWebHostBuilder(b => b.ConfigureTestServices(s =>
            s.AddSingleton<IIdentityProviderAdmin, RefusingIdentityProvider>()));

        var resp = await Authed(token, null).SendAsync(new HttpRequestMessage(HttpMethod.Get, "/api/v1/auth/me"));
        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        HttpClient viaRefusing = refusing.CreateClient();
        viaRefusing.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var deleted = await viaRefusing.SendAsync(new HttpRequestMessage(HttpMethod.Delete, "/api/v1/auth/me") { Content = JsonContent.Create(new { confirm = "SUPPRIMER" }) });

        deleted.StatusCode.Should().Be(HttpStatusCode.BadGateway);
        await AssertIntactAsync(vault);
        (await DbAsync(db => db.Users.CountAsync(u => u.Id == userId))).Should().Be(1);
        (await Authed(token).GetAsync("/api/v1/auth/me")).StatusCode.Should().Be(HttpStatusCode.OK);
    }
}
