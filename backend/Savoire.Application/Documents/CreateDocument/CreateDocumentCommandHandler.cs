// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using System.Security.Cryptography;
using System.Text;
using MediatR;
using Savoire.Application.Abstractions;
using Savoire.Application.Common;
using Savoire.Application.Notifications;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Documents.CreateDocument;

public class CreateDocumentCommandHandler(
    IDocumentRepository documents,
    IFolderRepository   folderRepo,
    IContentStore       contentStore,
    IPublisher          publisher)
    : IRequestHandler<CreateDocumentCommand, DocumentDto>
{
    public async Task<DocumentDto> Handle(CreateDocumentCommand cmd, CancellationToken ct)
    {
        // Access check delegated to VaultAccessBehavior (RequiredAccess = Write).

        if (await documents.GetByPathAsync(cmd.VaultId, cmd.Path, ct) is not null)
            throw new PathConflictException(cmd.Path);

        string? parentPath = GetParentFolderPath(cmd.Path);
        if (!string.IsNullOrEmpty(parentPath))
            await EnsureFolderPathAsync(cmd.VaultId, parentPath, ct);

        string body = cmd.Content ?? "";
        Document doc = Document.Create(
            cmd.VaultId, cmd.Path,
            ExtractTitle(body),
            Encoding.UTF8.GetByteCount(body),
            ComputeHash(body)
        );
        await documents.AddAsync(doc, ct);

        await using var stream = new MemoryStream(Encoding.UTF8.GetBytes(body));
        await contentStore.WriteDocumentAsync(cmd.VaultId, doc.Id, stream, ct);

        await publisher.Publish(new DocumentCreatedNotification(
            doc.Id, doc.VaultId, doc.Path, doc.Title, doc.CreatedAt, doc.UpdatedAt), ct);

        return DocumentDto.FromDomain(doc);
    }

    private async Task EnsureFolderPathAsync(string vaultId, string path, CancellationToken ct)
    {
        string[] segments = path.Split('/', StringSplitOptions.RemoveEmptyEntries);
        var current = new StringBuilder();
        foreach (string segment in segments)
        {
            if (current.Length > 0) current.Append('/');
            current.Append(segment);
            string segPath = current.ToString();
            if (await folderRepo.GetByPathAsync(vaultId, segPath, ct) is not null) continue;
            await folderRepo.AddAsync(Folder.Create(vaultId, segPath), ct);
        }
    }

    private static string? GetParentFolderPath(string path)
    {
        int lastSlash = path.LastIndexOf('/');
        return lastSlash > 0 ? path[..lastSlash] : null;
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
