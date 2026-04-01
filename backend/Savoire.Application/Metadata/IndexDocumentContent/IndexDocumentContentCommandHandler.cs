// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using System.Text.Json;
using MediatR;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Repositories;
using Savoire.Application.Services;

namespace Savoire.Application.Metadata.IndexDocumentContent;

public class IndexDocumentContentCommandHandler(
    IDocumentMetaRepository metas,
    IDocLinkRepository      links,
    IDocumentRepository     documents)
    : IRequestHandler<IndexDocumentContentCommand>
{
    public async Task Handle(IndexDocumentContentCommand cmd, CancellationToken ct)
    {
        var result = MarkdownMetaExtractor.Extract(cmd.MarkdownContent);

        // Upsert DocumentMeta
        var meta = await metas.GetByDocumentIdAsync(cmd.DocId, ct)
                   ?? DocumentMeta.Create(cmd.DocId, cmd.VaultId, cmd.ContentType, cmd.DerivedFrom, cmd.DerivedBy);

        meta.UpdateIndex(result.Tags, result.FrontmatterJson);
        await metas.UpsertAsync(meta, ct);

        // Sync Document.Title from frontmatter so DocumentDto returns the right title
        var doc = await documents.GetByIdAsync(cmd.DocId, ct);
        if (doc is not null)
        {
            string? frontmatterTitle = null;
            if (!string.IsNullOrEmpty(result.FrontmatterJson))
            {
                try
                {
                    using var json = JsonDocument.Parse(result.FrontmatterJson);
                    if (json.RootElement.TryGetProperty("title", out var titleEl))
                        frontmatterTitle = titleEl.GetString()?.Trim();
                }
                catch { /* malformed JSON — leave title as-is */ }
            }
            doc.UpdateTitle(string.IsNullOrWhiteSpace(frontmatterTitle) ? null : frontmatterTitle);
            await documents.UpdateAsync(doc, ct);
        }

        // Remplace les liens de ce document source
        var newLinks = new List<DocLink>();
        foreach (var wl in result.Wikilinks)
        {
            // Résolution du targetId par path
            var target = await documents.GetByPathAsync(cmd.VaultId, wl.TargetPath, ct)
                      ?? await documents.GetByPathAsync(cmd.VaultId, wl.TargetPath + ".md", ct);

            newLinks.Add(DocLink.Create(
                sourceId:   cmd.DocId,
                vaultId:    cmd.VaultId,
                targetPath: wl.TargetPath,
                targetId:   target?.Id,
                linkType:   wl.LinkType));
        }

        await links.ReplaceForSourceAsync(cmd.DocId, newLinks, ct);
    }
}
