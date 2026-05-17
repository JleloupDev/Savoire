// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using System.Text.RegularExpressions;
using MediatR;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Documents.SyncDocumentTitle;

public sealed record SyncDocumentTitleCommand(string DocId, string MarkdownContent) : IRequest;

public sealed class SyncDocumentTitleCommandHandler(IDocumentRepository documents)
    : IRequestHandler<SyncDocumentTitleCommand>
{
    private static readonly Regex FrontmatterTitleRx =
        new(@"^---\s*\n(?:.*\n)*?title\s*:\s*(?<title>[^\n]+)\n(?:.*\n)*?---", RegexOptions.Compiled);

    public async Task Handle(SyncDocumentTitleCommand cmd, CancellationToken ct)
    {
        var doc = await documents.GetByIdAsync(cmd.DocId, ct);
        if (doc is null) return;

        string? title = null;
        var m = FrontmatterTitleRx.Match(cmd.MarkdownContent);
        if (m.Success)
        {
            var raw = m.Groups["title"].Value.Trim().Trim('"').Trim('\'');
            if (!string.IsNullOrWhiteSpace(raw)) title = raw;
        }

        doc.UpdateTitle(title);
        await documents.UpdateAsync(doc, ct);
    }
}
