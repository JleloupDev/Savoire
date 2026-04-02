// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Application.Notifications;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Documents.RenameDocument;

public class RenameDocumentCommandHandler(
    IVaultRepository    vaults,
    IDocumentRepository documents,
    IDocLinkRepository  docLinks,
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

        // Update the link index: links that pointed to oldPath
        // are updated to newPath with the same targetId (stable UUID).
        await docLinks.UpdateTargetPathAsync(vaultId, oldPath, cmd.NewPath, doc.Id, ct);

        // Find documents that contain [[oldPath]] for the client-side CRDT cascade
        var affectedLinks = await docLinks.GetByTargetPathAsync(vaultId, cmd.NewPath, ct);
        var affectedDocIds = affectedLinks.Select(l => l.SourceId).Distinct().ToList();

        await publisher.Publish(new DocumentRenamedNotification(
            doc.Id, doc.VaultId, oldPath, doc.Path, doc.UpdatedAt), ct);

        // Notify clients of the required wikilink cascade
        if (affectedDocIds.Count > 0)
        {
            await publisher.Publish(new WikilinkCascadeNotification(
                vaultId, oldPath, cmd.NewPath, affectedDocIds), ct);
        }

        return DocumentDto.FromDomain(doc);
    }
}
