// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Application.Sharing;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Enums;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Documents.ListDocuments;

public class ListDocumentsQueryHandler(
    IDocumentRepository  documents,
    IShareLinkRepository shareLinks)
    : IRequestHandler<ListDocumentsQuery, IReadOnlyList<DocumentDto>>
{
    public async Task<IReadOnlyList<DocumentDto>> Handle(
        ListDocumentsQuery q, CancellationToken ct)
    {
        // VaultAccessBehavior handles access for normal callers.
        // ShareLink callers are excluded from the behavior — check here.
        if (ShareLinkGuard.IsShareLinkCaller(q.CallerId))
            await ShareLinkGuard.RequireVaultReadAsync(q.CallerId, q.VaultId, shareLinks, ct);

        IReadOnlyList<Document> docs =
            await documents.ListAsync(q.VaultId, q.FolderPrefix, q.IncludeDeleted, ct);
        return docs.Select(DocumentDto.FromDomain).ToList();
    }

    // DECISION: these static methods stay here because DeleteDocument and RenameDocument
    // use "__resolve__" for VaultId — they cannot implement IRequiresVaultAccess.
    // Migrate once those commands resolve the VaultId before dispatch.

    internal static async Task RequireAccessAsync(
        string callerId, string vaultId, IVaultRepository vaults, CancellationToken ct)
    {
        Vault? vault = await vaults.GetByIdAsync(vaultId, ct);
        if (vault is null) throw new VaultNotFoundException(vaultId);
        if (vault.IsOwner(callerId)) return;
        VaultMember? member = await vaults.GetMemberAsync(vaultId, callerId, ct);
        if (member is null) throw new VaultNotFoundException(vaultId);
    }

    internal static async Task RequireWriteAccessAsync(
        string callerId, string vaultId, IVaultRepository vaults, CancellationToken ct)
    {
        Vault? vault = await vaults.GetByIdAsync(vaultId, ct);
        if (vault is null) throw new VaultNotFoundException(vaultId);
        if (vault.IsOwner(callerId)) return;
        VaultMember? member = await vaults.GetMemberAsync(vaultId, callerId, ct);
        if (member is null) throw new VaultNotFoundException(vaultId);
        if (member.Role == VaultRole.Viewer)
            throw new AccessDeniedException("Les membres 'viewer' ne peuvent pas modifier ce vault.");
    }
}
