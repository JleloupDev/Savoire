// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Tests unitaires — IndexDocumentContentCommandHandler

using FluentAssertions;
using NSubstitute;
using NSubstitute.ReturnsExtensions;
using Savoire.Application.Metadata.IndexDocumentContent;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Repositories;

namespace Savoire.Server.Unit.Tests.Metadata;

public class IndexDocumentContentCommandHandlerTests
{
    private readonly IDocumentMetaRepository  _metas;
    private readonly IDocLinkRepository       _links;
    private readonly IDocumentRepository      _documents;
    private readonly IndexDocumentContentCommandHandler _sut;

    public IndexDocumentContentCommandHandlerTests()
    {
        _metas     = Substitute.For<IDocumentMetaRepository>();
        _links     = Substitute.For<IDocLinkRepository>();
        _documents = Substitute.For<IDocumentRepository>();
        _sut       = new IndexDocumentContentCommandHandler(_metas, _links, _documents);

        // Par défaut : GetByDocumentIdAsync retourne null (pas de meta existante)
        _metas.GetByDocumentIdAsync(Arg.Any<string>(), Arg.Any<CancellationToken>())
              .ReturnsNull();
        // Par défaut : aucun document cible trouvé
        _documents.GetByPathAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
                  .ReturnsNull();
    }

    [Fact]
    public async Task Handle_NewDocument_UpsertsMeta()
    {
        var cmd = new IndexDocumentContentCommand(
            DocId: "doc-1", VaultId: "vault-1",
            MarkdownContent: "# Hello\n#tag1");

        await _sut.Handle(cmd, CancellationToken.None);

        await _metas.Received(1).UpsertAsync(
            Arg.Is<DocumentMeta>(m => m.DocumentId == "doc-1"),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Handle_WithInlineTag_TagStoredInMeta()
    {
        var cmd = new IndexDocumentContentCommand(
            DocId: "doc-1", VaultId: "vault-1",
            MarkdownContent: "# Note\n\nTest #design.");

        await _sut.Handle(cmd, CancellationToken.None);

        await _metas.Received(1).UpsertAsync(
            Arg.Is<DocumentMeta>(m => m.Tags.Contains("design")),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Handle_WithWikilinks_LinksAreReplaced()
    {
        var cmd = new IndexDocumentContentCommand(
            DocId: "doc-1", VaultId: "vault-1",
            MarkdownContent: "Voir [[Architecture]] et [[Inbox/notes]].");

        await _sut.Handle(cmd, CancellationToken.None);

        await _links.Received(1).ReplaceForSourceAsync(
            "doc-1",
            Arg.Is<IReadOnlyList<DocLink>>(l => l.Count == 2),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Handle_WithNoWikilinks_ReplacesWithEmptyList()
    {
        var cmd = new IndexDocumentContentCommand(
            DocId: "doc-2", VaultId: "vault-1",
            MarkdownContent: "# Note sans liens.");

        await _sut.Handle(cmd, CancellationToken.None);

        await _links.Received(1).ReplaceForSourceAsync(
            "doc-2",
            Arg.Is<IReadOnlyList<DocLink>>(l => l.Count == 0),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Handle_WhenTargetDocExists_LinkHasTargetId()
    {
        var targetDoc = Document.Create("vault-1", "Architecture.md", null, 0, "");
        _documents.GetByPathAsync("vault-1", "Architecture", Arg.Any<CancellationToken>())
                  .Returns(targetDoc);

        var cmd = new IndexDocumentContentCommand(
            DocId: "doc-1", VaultId: "vault-1",
            MarkdownContent: "Voir [[Architecture]].");

        await _sut.Handle(cmd, CancellationToken.None);

        await _links.Received(1).ReplaceForSourceAsync(
            "doc-1",
            Arg.Is<IReadOnlyList<DocLink>>(l =>
                l.Count == 1 && l[0].TargetId == targetDoc.Id),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Handle_ExistingMeta_IsUpdatedNotRecreated()
    {
        var existingMeta = DocumentMeta.Create("doc-1", "vault-1", "text/markdown", null, null);
        _metas.GetByDocumentIdAsync("doc-1", Arg.Any<CancellationToken>()).Returns(existingMeta);

        var cmd = new IndexDocumentContentCommand(
            DocId: "doc-1", VaultId: "vault-1",
            MarkdownContent: "# Updated\n#newtag");

        await _sut.Handle(cmd, CancellationToken.None);

        await _metas.Received(1).UpsertAsync(
            Arg.Is<DocumentMeta>(m => m.Tags.Contains("newtag")),
            Arg.Any<CancellationToken>());
    }
}
