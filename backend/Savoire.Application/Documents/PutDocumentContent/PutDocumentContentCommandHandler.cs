// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using System.Security.Cryptography;
using System.Text;
using MediatR;
using Savoire.Application.Abstractions;
using Savoire.Application.Common;
using Savoire.Application.Sharing;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Documents.PutDocumentContent;

public sealed class PutDocumentContentCommandHandler(
    IDocumentRepository  documents,
    IShareLinkRepository shareLinks,
    IContentStore        contentStore)
    : IRequestHandler<PutDocumentContentCommand, DocumentDto>
{
    public async Task<DocumentDto> Handle(PutDocumentContentCommand cmd, CancellationToken ct)
    {
        // VaultAccessBehavior handles normal callers.
        // ShareLink/View callers — document-level check here.
        if (ShareLinkGuard.IsShareLinkCaller(cmd.CallerId) || ShareLinkGuard.IsViewCaller(cmd.CallerId))
            await ShareLinkGuard.RequireDocumentWriteAsync(cmd.CallerId, cmd.VaultId, cmd.DocId, shareLinks, ct);

        Document? doc = await documents.GetByIdAsync(cmd.DocId, ct);
        if (doc is null || doc.VaultId != cmd.VaultId) throw new DocumentNotFoundException(cmd.DocId);

        doc.UpdateContent(ExtractTitle(cmd.Body), Encoding.UTF8.GetByteCount(cmd.Body), ComputeHash(cmd.Body));
        await documents.UpdateAsync(doc, ct);

        await using var stream = new MemoryStream(Encoding.UTF8.GetBytes(cmd.Body));
        await contentStore.WriteDocumentAsync(cmd.VaultId, cmd.DocId, stream, ct);

        return DocumentDto.FromDomain(doc);
    }

    private static string ComputeHash(string content)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(content);
        return Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    }

    private static string? ExtractTitle(string content)
    {
        foreach (string line in content.Split('\n'))
        {
            string trimmed = line.Trim();
            if (trimmed.StartsWith("# ")) return trimmed[2..].Trim();
            if (trimmed.Length > 0) return trimmed[..Math.Min(80, trimmed.Length)];
        }
        return null;
    }
}
