// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;

namespace Savoire.Application.Sync.JoinDocument;

/// <summary>
/// Returned by JoinDocumentQueryHandler.
/// CallerIsVaultMember lets SyncHub decide whether to add the connection
/// to the doc-events group (for non-member shared-note subscribers).
/// </summary>
public record JoinDocumentResult(string[] Ops, bool CallerIsVaultMember);

public record JoinDocumentQuery(
    string CallerId,
    string VaultId,
    string DocId) : IRequest<JoinDocumentResult>, IRequiresDocumentAccess
{
    public VaultAccessLevel RequiredAccess => VaultAccessLevel.Read;
}
