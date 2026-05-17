// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Notifications;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Documents.DeleteDocument;

public sealed class DeleteDocumentCommandHandler(
    IVaultRepository    vaults,
    IDocumentRepository documents,
    IPublisher          publisher)
    : IRequestHandler<DeleteDocumentCommand>
{
    public async Task Handle(DeleteDocumentCommand cmd, CancellationToken ct)
    {
        Document? doc = await documents.GetByIdAsync(cmd.DocId, ct);
        if (doc is null) throw new DocumentNotFoundException(cmd.DocId);

        string vaultId = cmd.VaultId == "__resolve__" ? doc.VaultId : cmd.VaultId;
        if (doc.VaultId != vaultId) throw new DocumentNotFoundException(cmd.DocId);

        await ListDocuments.ListDocumentsQueryHandler.RequireWriteAccessAsync(cmd.CallerId, vaultId, vaults, ct);

        doc.SoftDelete();
        await documents.UpdateAsync(doc, ct);

        await publisher.Publish(new DocumentDeletedNotification(
            doc.Id, doc.VaultId, doc.Path, doc.DeletedAt!.Value), ct);
    }
}
