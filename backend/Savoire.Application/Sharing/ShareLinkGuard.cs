// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup

using Savoire.Domain.Aggregates;
using Savoire.Domain.Enums;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Sharing;

public static class ShareLinkGuard
{
    public static bool IsShareLinkCaller(string callerId) =>
        callerId.StartsWith("share:", StringComparison.Ordinal);
    public static bool IsViewCaller(string callerId) =>
        callerId.StartsWith("view:", StringComparison.Ordinal);

    private static string ExtractLinkId(string callerId) => callerId["share:".Length..];
    private static (string VaultId, string DocId, string Permission) ParseViewCaller(string callerId)
    {
        // Format: view:{vaultId}:{docId}:{permission}
        string[] parts = callerId.Split(':', 4, StringSplitOptions.None);
        if (parts.Length != 4 || parts[0] != "view")
            throw new AccessDeniedException("Token view invalide.");
        return (parts[1], parts[2], parts[3].ToLowerInvariant());
    }

    // ── Vault access ──────────────────────────────────────────────────────────

    /// <summary>Verifies that a vault share link grants read access to this vault.</summary>
    public static async Task RequireVaultReadAsync(
        string callerId, string vaultId,
        IShareLinkRepository shareLinks, CancellationToken ct)
    {
        if (IsViewCaller(callerId))
        {
            var view = ParseViewCaller(callerId);
            if (view.VaultId == vaultId) return;
            throw new AccessDeniedException("Token view non valide pour ce vault.");
        }

        ShareLink link = await GetValidLinkOrThrowAsync(callerId, shareLinks, ct);
        if (link.ResourceType == ResourceType.Vault && link.ResourceId == vaultId) return;
        throw new AccessDeniedException("Lien de partage non valide pour ce vault.");
    }

    /// <summary>Verifies that a vault share link grants write access to this vault.</summary>
    public static async Task RequireVaultWriteAsync(
        string callerId, string vaultId,
        IShareLinkRepository shareLinks, CancellationToken ct)
    {
        if (IsViewCaller(callerId))
        {
            var view = ParseViewCaller(callerId);
            if (view.VaultId == vaultId && view.Permission == "write") return;
            throw new AccessDeniedException("Token view sans permission d'écriture sur ce vault.");
        }

        ShareLink link = await GetValidLinkOrThrowAsync(callerId, shareLinks, ct);
        if (link.ResourceType == ResourceType.Vault && link.ResourceId == vaultId && link.AllowsWrite()) return;
        throw new AccessDeniedException("Lien de partage sans permission d'écriture sur ce vault.");
    }

    // ── Document access ───────────────────────────────────────────────────────

    /// <summary>
    /// Verifies read access to a document via a share link.
    /// Accepts: a vault link covering this vault, or a document link covering this document.
    /// </summary>
    public static async Task RequireDocumentReadAsync(
        string callerId, string vaultId, string docId,
        IShareLinkRepository shareLinks, CancellationToken ct)
    {
        if (IsViewCaller(callerId))
        {
            var view = ParseViewCaller(callerId);
            if (view.VaultId == vaultId && view.DocId == docId) return;
            throw new AccessDeniedException("Token view non valide pour ce document.");
        }

        ShareLink link = await GetValidLinkOrThrowAsync(callerId, shareLinks, ct);
        if (link.ResourceType == ResourceType.Vault    && link.ResourceId == vaultId) return;
        if (link.ResourceType == ResourceType.Document && link.ResourceId == docId)   return;
        throw new AccessDeniedException("Lien de partage non valide pour ce document.");
    }

    /// <summary>
    /// Verifies write access to a document via a share link.
    /// Accepts: a vault write link covering this vault, or a document write link covering this document.
    /// </summary>
    public static async Task RequireDocumentWriteAsync(
        string callerId, string vaultId, string docId,
        IShareLinkRepository shareLinks, CancellationToken ct)
    {
        if (IsViewCaller(callerId))
        {
            var view = ParseViewCaller(callerId);
            if (view.VaultId == vaultId && view.DocId == docId && view.Permission == "write") return;
            throw new AccessDeniedException("Token view sans permission d'écriture sur ce document.");
        }

        ShareLink link = await GetValidLinkOrThrowAsync(callerId, shareLinks, ct);
        if (link.ResourceType == ResourceType.Vault    && link.ResourceId == vaultId && link.AllowsWrite()) return;
        if (link.ResourceType == ResourceType.Document && link.ResourceId == docId   && link.AllowsWrite()) return;
        throw new AccessDeniedException("Lien de partage sans permission d'écriture sur ce document.");
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    private static async Task<ShareLink> GetValidLinkOrThrowAsync(
        string callerId, IShareLinkRepository shareLinks, CancellationToken ct)
    {
        string linkId = ExtractLinkId(callerId);
        ShareLink? link = await shareLinks.GetByIdAsync(linkId, ct);
        if (link is null || !link.IsValid())
            throw new AccessDeniedException("Lien de partage invalide ou expiré.");
        return link;
    }
}
