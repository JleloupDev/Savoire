// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup

using Savoire.Domain.Aggregates;
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

    /// <summary>Vérifie qu'un lien de partage de vault autorise la lecture de ce vault.</summary>
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
        if (link.ResourceType == "vault" && link.ResourceId == vaultId) return;
        throw new AccessDeniedException("Lien de partage non valide pour ce vault.");
    }

    /// <summary>Vérifie qu'un lien de partage de vault autorise l'écriture dans ce vault.</summary>
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
        if (link.ResourceType == "vault" && link.ResourceId == vaultId && link.AllowsWrite()) return;
        throw new AccessDeniedException("Lien de partage sans permission d'écriture sur ce vault.");
    }

    // ── Document access ───────────────────────────────────────────────────────

    /// <summary>
    /// Vérifie la lecture d'un document via un lien de partage.
    /// Accepte : lien vault couvrant ce vault, ou lien document couvrant ce document.
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
        if (link.ResourceType == "vault"    && link.ResourceId == vaultId) return;
        if (link.ResourceType == "document" && link.ResourceId == docId)   return;
        throw new AccessDeniedException("Lien de partage non valide pour ce document.");
    }

    /// <summary>
    /// Vérifie l'écriture d'un document via un lien de partage.
    /// Accepte : lien vault write couvrant ce vault, ou lien document write couvrant ce document.
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
        if (link.ResourceType == "vault"    && link.ResourceId == vaultId && link.AllowsWrite()) return;
        if (link.ResourceType == "document" && link.ResourceId == docId   && link.AllowsWrite()) return;
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
