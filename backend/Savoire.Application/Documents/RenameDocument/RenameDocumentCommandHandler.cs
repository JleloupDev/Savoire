// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Application.Notifications;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Documents.RenameDocument;

public sealed class RenameDocumentCommandHandler(
    IVaultRepository    vaults,
    IDocumentRepository documents,
    IPublisher          publisher)
    : IRequestHandler<RenameDocumentCommand, DocumentDto>
{
    public async Task<DocumentDto> Handle(RenameDocumentCommand cmd, CancellationToken ct)
    {
        Document? doc = await documents.GetByIdAsync(cmd.DocId, ct);
        if (doc is null) throw new DocumentNotFoundException(cmd.DocId);

        string vaultId = cmd.VaultId == "__resolve__" ? doc.VaultId : cmd.VaultId;
        if (doc.VaultId != vaultId) throw new DocumentNotFoundException(cmd.DocId);

        await ListDocuments.ListDocumentsQueryHandler.RequireWriteAccessAsync(cmd.CallerId, vaultId, vaults, ct);

        if (await documents.GetByPathAsync(vaultId, cmd.NewPath, ct) is not null)
            throw new PathConflictException(cmd.NewPath);

        string oldPath = doc.Path;
        doc.Rename(cmd.NewPath);
        await documents.UpdateAsync(doc, ct);

        await publisher.Publish(new DocumentRenamedNotification(
            doc.Id, doc.VaultId, oldPath, doc.Path, doc.UpdatedAt), ct);

        return DocumentDto.FromDomain(doc);
    }
}
