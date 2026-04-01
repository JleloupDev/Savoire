// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Tests unitaires — MarkdownMetaExtractor (logique pure, pas de dépendance externe)

using FluentAssertions;
using Savoire.Application.Services;

namespace Savoire.Server.Unit.Tests.Metadata;

public class MarkdownMetaExtractorTests
{
    // ── Tags ─────────────────────────────────────────────────────────────────

    [Fact]
    public void Extract_InlineTag_IsDetected()
    {
        var result = MarkdownMetaExtractor.Extract("# Note\n\nCeci est #important et #projet/alpha.");
        result.Tags.Should().Contain("important");
        result.Tags.Should().Contain("projet/alpha");
    }

    [Fact]
    public void Extract_FrontmatterTags_AreDetected()
    {
        var md = "---\ntags: [design, ux]\n---\n\nCorps.";
        var result = MarkdownMetaExtractor.Extract(md);
        result.Tags.Should().Contain("design");
        result.Tags.Should().Contain("ux");
    }

    [Fact]
    public void Extract_FrontmatterAndInlineTags_Merged()
    {
        var md = "---\ntags: [frontend]\n---\n\nNote avec #backend.";
        var result = MarkdownMetaExtractor.Extract(md);
        result.Tags.Should().Contain("frontend");
        result.Tags.Should().Contain("backend");
    }

    [Fact]
    public void Extract_Tags_AreDeduplicated_CaseInsensitive()
    {
        var md = "---\ntags: [Design]\n---\n\nCeci est #design.";
        var result = MarkdownMetaExtractor.Extract(md);
        result.Tags.Should().ContainSingle(t => t.Equals("Design", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void Extract_NoTags_ReturnsEmptyArray()
    {
        var result = MarkdownMetaExtractor.Extract("# Just a title\nParagraph.");
        result.Tags.Should().BeEmpty();
    }

    // ── Wikilinks ─────────────────────────────────────────────────────────────

    [Fact]
    public void Extract_WikilinkSimple_IsDetected()
    {
        var result = MarkdownMetaExtractor.Extract("Voir [[Architecture/Decisions]].");
        result.Wikilinks.Should().ContainSingle(w => w.TargetPath == "Architecture/Decisions" && w.LinkType == "wikilink");
    }

    [Fact]
    public void Extract_EmbedLink_HasEmbedType()
    {
        var result = MarkdownMetaExtractor.Extract("![[image.png]]");
        result.Wikilinks.Should().ContainSingle(w => w.TargetPath == "image.png" && w.LinkType == "embed");
    }

    [Fact]
    public void Extract_WikilinkWithAlias_TargetPathHasNoAlias()
    {
        var result = MarkdownMetaExtractor.Extract("[[Inbox/note|Mon alias]]");
        result.Wikilinks.Should().ContainSingle(w => w.TargetPath == "Inbox/note");
    }

    [Fact]
    public void Extract_MultipleWikilinks_AllDetected()
    {
        var result = MarkdownMetaExtractor.Extract("Voir [[A]] et [[B]] et ![[C.png]].");
        result.Wikilinks.Should().HaveCount(3);
    }

    [Fact]
    public void Extract_NoWikilinks_ReturnsEmptyList()
    {
        var result = MarkdownMetaExtractor.Extract("# Titre\nPas de liens ici.");
        result.Wikilinks.Should().BeEmpty();
    }

    // ── Frontmatter JSON ─────────────────────────────────────────────────────

    [Fact]
    public void Extract_NoFrontmatter_ReturnEmptyJsonObject()
    {
        var result = MarkdownMetaExtractor.Extract("# Titre\nCorps.");
        result.FrontmatterJson.Should().Be("{}");
    }

    [Fact]
    public void Extract_FrontmatterWithFields_SerializedAsJson()
    {
        var md = "---\ntitle: Mon titre\nstatus: draft\n---\n\nCorps.";
        var result = MarkdownMetaExtractor.Extract(md);
        result.FrontmatterJson.Should().Contain("\"title\"");
        result.FrontmatterJson.Should().Contain("Mon titre");
        result.FrontmatterJson.Should().Contain("\"status\"");
    }

    [Fact]
    public void Extract_FrontmatterWithList_SerializedAsJsonArray()
    {
        var md = "---\ntags: [a, b, c]\n---\nCorps.";
        var result = MarkdownMetaExtractor.Extract(md);
        result.FrontmatterJson.Should().Contain("\"tags\"");
        result.FrontmatterJson.Should().Contain("\"a\"");
    }

    // ── Edge cases ────────────────────────────────────────────────────────────

    [Fact]
    public void Extract_EmptyString_ReturnsEmptyResult()
    {
        var result = MarkdownMetaExtractor.Extract("");
        result.Tags.Should().BeEmpty();
        result.Wikilinks.Should().BeEmpty();
        result.FrontmatterJson.Should().Be("{}");
    }

    [Fact]
    public void Extract_TagInFrontmatterDoesNotIncludeHash()
    {
        var md = "---\ntags: [#mytag]\n---\nCorps.";
        var result = MarkdownMetaExtractor.Extract(md);
        result.Tags.Should().Contain("mytag");
        result.Tags.Should().NotContain("#mytag");
    }
}
