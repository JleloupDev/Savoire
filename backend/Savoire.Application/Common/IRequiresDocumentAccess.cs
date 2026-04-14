// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
namespace Savoire.Application.Common;

/// <summary>
/// Marker interface for commands/queries that operate on a specific document.
/// VaultAccessBehavior checks vault membership first; if the caller is not a
/// vault member, it falls back to document-level resource_permissions.
/// see ADR-026
/// </summary>
public interface IRequiresDocumentAccess
{
    string           CallerId       { get; }
    string           VaultId        { get; }
    string           DocId          { get; }
    VaultAccessLevel RequiredAccess { get; }
}
