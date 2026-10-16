// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Controle d'acces des pieces jointes (images).
//
// La lecture etait anonyme et l'ecriture ouverte a tout compte connecte,
// quel que soit le vault. Desormais : lire exige le droit de lecture sur le
// vault, ecrire ou supprimer le droit d'ecriture. Le client lit l'image en
// fetch authentifie et l'affiche par une URL blob:.

using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using FluentAssertions;
using Savoire.Application.Common;

namespace Savoire.Server.Integration.Tests.Vaults;

[Collection("Integration")]
public class AttachmentsAccessTests : IClassFixture<AppFactory>, IAsyncLifetime
{
    // Un PNG minimal : la signature suffit pour deviner le type.
    private static readonly byte[] Png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4];

    private readonly AppFactory _factory;
    private HttpClient _owner = null!;
    private string _ownerToken = null!;
    private HttpClient _intruder = null!;
    private HttpClient _reader = null!;
    private string _vaultId = null!;

    public AttachmentsAccessTests(AppFactory factory) => _factory = factory;

    public async Task InitializeAsync()
    {
        var uid = Guid.NewGuid().ToString("N")[..8];
        (string ownerToken, string ownerId) = await _factory.CreateUserAndGetTokenAsync($"att-owner-{uid}@test.com", displayName: "Owner");
        _ownerToken = ownerToken;
        (string intruderToken, _) = await _factory.CreateUserAndGetTokenAsync($"att-intruder-{uid}@test.com", displayName: "Intruder");
        (string readerToken, string readerId) = await _factory.CreateUserAndGetTokenAsync($"att-reader-{uid}@test.com", displayName: "Reader");

        _owner = Client(ownerToken);
        _intruder = Client(intruderToken);
        _reader = Client(readerToken);

        var vaultResp = await _owner.PostAsJsonAsync($"/api/v1/users/{ownerId}/vaults", new { name = "Vault images" });
        vaultResp.EnsureSuccessStatusCode();
        _vaultId = (await vaultResp.Content.ReadFromJsonAsync<VaultSummaryDto>())!.Id;

        var grant = await _owner.PostAsJsonAsync(
            $"/api/v1/vaults/{_vaultId}/sharing/permissions",
            new { subjectId = readerId, permission = "read", expiresAt = (DateTime?)null });
        grant.EnsureSuccessStatusCode();
    }

    public Task DisposeAsync() => Task.CompletedTask;

    private HttpClient Client(string token)
    {
        var c = _factory.CreateClient();
        c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return c;
    }

    private static MultipartFormDataContent PngForm(string fileName = "Mon image.png")
    {
        var content = new ByteArrayContent(Png);
        content.Headers.ContentType = new MediaTypeHeaderValue("image/png");
        return new MultipartFormDataContent { { content, "file", fileName } };
    }

    private string Url(string path = "") => $"/api/v1/vaults/{_vaultId}/attachments{(path.Length > 0 ? "/" + path : "")}";

    private async Task<string> OwnerUploadsAsync()
    {
        string fileId = Guid.NewGuid().ToString();
        var resp = await _owner.PostAsync(Url(fileId), PngForm());
        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        return fileId;
    }

    [Fact(DisplayName = "Pieces jointes — le proprietaire depose sous l'id du document puis relit l'image")]
    public async Task Owner_UploadsWithId_ThenReads()
    {
        string fileId = await OwnerUploadsAsync();

        var get = await _owner.GetAsync(Url(fileId));
        get.StatusCode.Should().Be(HttpStatusCode.OK);
        // Range sans extension : le type se lit dans la signature du fichier.
        get.Content.Headers.ContentType!.MediaType.Should().Be("image/png");
        (await get.Content.ReadAsByteArrayAsync()).Should().Equal(Png);
    }

    [Fact(DisplayName = "Pieces jointes — la lecture n'est plus anonyme")]
    public async Task Anonymous_CannotRead()
    {
        string fileId = await OwnerUploadsAsync();
        var get = await _factory.CreateClient().GetAsync(Url(fileId));
        get.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact(DisplayName = "Pieces jointes — un non-membre ne lit, n'ecrit ni ne supprime rien")]
    public async Task NonMember_IsRejected()
    {
        string fileId = await OwnerUploadsAsync();

        (await _intruder.GetAsync(Url(fileId))).StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await _intruder.PostAsync(Url(Guid.NewGuid().ToString()), PngForm())).StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await _intruder.PostAsync(Url(), PngForm())).StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await _intruder.DeleteAsync(Url(fileId))).StatusCode.Should().Be(HttpStatusCode.NotFound);

        // Et l'image du proprietaire est toujours la.
        (await _owner.GetAsync(Url(fileId))).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact(DisplayName = "Pieces jointes — un lecteur du vault lit mais n'ecrit pas")]
    public async Task Reader_CanReadButNotWrite()
    {
        string fileId = await OwnerUploadsAsync();

        (await _reader.GetAsync(Url(fileId))).StatusCode.Should().Be(HttpStatusCode.OK);
        (await _reader.PostAsync(Url(Guid.NewGuid().ToString()), PngForm())).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await _reader.DeleteAsync(Url(fileId))).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact(DisplayName = "Pieces jointes — un chemin qui sort du dossier du vault est refuse")]
    public async Task PathTraversal_IsRejected()
    {
        var get = await _owner.GetAsync(Url("..%2F..%2Fmetadata.db"));
        get.StatusCode.Should().NotBe(HttpStatusCode.OK);
        var post = await _owner.PostAsync(Url("..%2Fx"), PngForm());
        post.StatusCode.Should().NotBe(HttpStatusCode.OK);
    }

    [Fact(DisplayName = "Pieces jointes — l'ancien envoi sans id marche toujours pour un redacteur")]
    public async Task LegacyUpload_StillWorksForOwner()
    {
        var resp = await _owner.PostAsync(Url(), PngForm("ancien.png"));
        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var dto = await resp.Content.ReadFromJsonAsync<AttachmentInfo>();
        dto!.Path.Should().EndWith(".png");
        (await _owner.GetAsync(Url(dto.Path))).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    // ── Partage d'une note : les images rangees dans son dossier ─────────────

    /// <summary>Image inscrite au registre et deposee, comme le fait le client.</summary>
    private async Task<string> OwnerUploadsRegisteredAsync()
    {
        string fileId = await _factory.NewDocumentAsync(_ownerToken, _vaultId);
        (await _owner.PostAsync(Url(fileId), PngForm())).StatusCode.Should().Be(HttpStatusCode.OK);
        return fileId;
    }

    private Task<HttpResponseMessage> PlaceAsync(HttpClient client, string fileId, string? noteId, string name = "Photo.png") =>
        client.PutAsJsonAsync(Url($"{fileId}/placement"), new { noteId, name });

    /// <summary>Client authentifie par un lien de partage en lecture vers cette note.</summary>
    private async Task<(HttpClient Client, ShareLinkAccessDto Access)> ShareNoteAsync(string noteId)
    {
        var linkResp = await _owner.PostAsJsonAsync($"/api/v1/documents/{noteId}/sharing/links", new { permission = "read" });
        linkResp.EnsureSuccessStatusCode();
        var link = await linkResp.Content.ReadFromJsonAsync<ShareLinkDto>();
        var access = await (await _factory.CreateClient().GetAsync($"/api/v1/share/{link!.Token}/access"))
            .Content.ReadFromJsonAsync<ShareLinkAccessDto>();
        return (Client(access!.AccessToken), access);
    }

    [Fact(DisplayName = "Partage d'une note — lit l'image rangee dans son dossier, pas une autre image du vault")]
    public async Task NoteShareLink_ReadsOnlyImagesOfItsFolder()
    {
        string note = await _factory.NewDocumentAsync(_ownerToken, _vaultId);
        string otherNote = await _factory.NewDocumentAsync(_ownerToken, _vaultId);
        string inFolder = await OwnerUploadsRegisteredAsync();
        string elsewhere = await OwnerUploadsRegisteredAsync();       // attachments/, sans note
        string otherFolder = await OwnerUploadsRegisteredAsync();     // dossier d'une autre note
        (await PlaceAsync(_owner, inFolder, note)).StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await PlaceAsync(_owner, otherFolder, otherNote)).StatusCode.Should().Be(HttpStatusCode.NoContent);

        var (viaLink, access) = await ShareNoteAsync(note);
        access.VaultId.Should().Be(_vaultId);

        var ok = await viaLink.GetAsync(Url(inFolder));
        ok.StatusCode.Should().Be(HttpStatusCode.OK);
        (await ok.Content.ReadAsByteArrayAsync()).Should().Equal(Png);
        (await viaLink.GetAsync(Url(elsewhere))).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await viaLink.GetAsync(Url(otherFolder))).StatusCode.Should().Be(HttpStatusCode.Forbidden);

        // La page de partage connait le nom de l'image a afficher.
        var list = await viaLink.GetFromJsonAsync<List<NoteAttachment>>($"/api/v1/vaults/{_vaultId}/documents/{note}/attachments");
        list.Should().ContainSingle().Which.Should().Be(new NoteAttachment(inFolder, "Photo.png"));
        // Mais pas celles d'une autre note.
        (await viaLink.GetAsync($"/api/v1/vaults/{_vaultId}/documents/{otherNote}/attachments")).StatusCode
            .Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact(DisplayName = "Partage d'une note — une image sortie du dossier n'est plus lisible par le lien")]
    public async Task NoteShareLink_ImageMovedOut_IsNoLongerReadable()
    {
        string note = await _factory.NewDocumentAsync(_ownerToken, _vaultId);
        string image = await OwnerUploadsRegisteredAsync();
        await PlaceAsync(_owner, image, note);
        var (viaLink, _) = await ShareNoteAsync(note);
        (await viaLink.GetAsync(Url(image))).StatusCode.Should().Be(HttpStatusCode.OK);

        (await PlaceAsync(_owner, image, null)).StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await viaLink.GetAsync(Url(image))).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact(DisplayName = "Partage d'une note — le lien n'ecrit ni ne range aucune piece jointe")]
    public async Task NoteShareLink_CannotWriteOrPlace()
    {
        string note = await _factory.NewDocumentAsync(_ownerToken, _vaultId);
        string image = await OwnerUploadsRegisteredAsync();
        await PlaceAsync(_owner, image, note);
        var (viaLink, _) = await ShareNoteAsync(note);

        (await viaLink.PostAsync(Url(image), PngForm())).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await viaLink.DeleteAsync(Url(image))).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await PlaceAsync(viaLink, image, note)).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact(DisplayName = "Rangement — reserve aux redacteurs, et seulement entre documents de ce vault")]
    public async Task Placement_IsCheckedAgainstTheRegistry()
    {
        string note = await _factory.NewDocumentAsync(_ownerToken, _vaultId);
        string image = await OwnerUploadsRegisteredAsync();
        string unregistered = await OwnerUploadsAsync();

        (await PlaceAsync(_reader, image, note)).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await PlaceAsync(_intruder, image, note)).StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await PlaceAsync(_owner, unregistered, note)).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await PlaceAsync(_owner, image, Guid.NewGuid().ToString())).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await PlaceAsync(_owner, image, note, "a/b.png")).StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    private sealed record AttachmentInfo(string FileName, string Path, long Size, string ContentType);
    private sealed record NoteAttachment(string Id, string? Name);
}
