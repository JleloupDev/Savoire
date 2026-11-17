// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Effacer un vault, c'est effacer TOUT ce qui lui appartient (revue du
// 14/11/2026, E2). Avant, seule la ligne du vault partait : le texte de ses
// notes (journal CRDT), ses liens de partage, ses pages publiees restaient en
// base, et dans les sauvegardes.
//
// Ce qui part ici, dans la transaction de la suppression :
//  - le journal CRDT : repertoire du vault, canaux d'index, documents et
//    rooms de ses documents (retrouves par le registre « document -> vault »,
//    lu AVANT que la suppression du vault ne l'emporte en cascade) ;
//  - les vecteurs de synchronisation des memes ressources ;
//  - les liens de partage et les droits, du vault et de ses documents ;
//  - les pages publiees, les blobs EdgeSync, les cles et identites du vault ;
//  - le vault dans les jetons personnels qui s'y limitaient.
// Les membres, dossiers, registre et reglage du pair partent en cascade
// (cles etrangeres). Les fichiers sont effaces par IContentStore, apres.
//
// PurgeOrphansAsync fait le meme menage pour ce qui a ete laisse par les
// suppressions d'avant, sans vault pour le designer.

using Microsoft.EntityFrameworkCore;
using Savoire.Application.Abstractions;
using Savoire.Domain.ReadModels;

namespace Savoire.Infrastructure.Persistence;

public sealed class VaultEraser(AppDbContext db, IContentStore files) : IOrphanPurger
{
    /// <summary>Les lignes du vault, hors celle du vault lui-meme. Dans une transaction.</summary>
    internal static async Task EraseRowsAsync(AppDbContext db, string vaultId, CancellationToken ct)
    {
        string vaultResource = "vault:" + vaultId;
        string indexPrefix = "index:" + vaultId + ":";

        await db.Database.ExecuteSqlAsync($"""
            DELETE FROM operations_log
            WHERE (resource_type IN ('document', 'room') AND resource_id IN (SELECT doc_id FROM vault_documents WHERE vault_id = {vaultId}))
               OR (resource_type = 'vault' AND resource_id = {vaultResource})
               OR (resource_type = 'index' AND starts_with(resource_id, {indexPrefix}))
            """, ct);
        await db.Database.ExecuteSqlAsync($"""
            DELETE FROM sync_vectors
            WHERE resource_id IN (SELECT doc_id FROM vault_documents WHERE vault_id = {vaultId})
               OR resource_id = {vaultResource}
               OR starts_with(resource_id, {indexPrefix})
            """, ct);
        await db.Database.ExecuteSqlAsync($"""
            DELETE FROM share_links
            WHERE (resource_type = 'vault' AND resource_id = {vaultId})
               OR (resource_type = 'document' AND resource_id IN (SELECT doc_id FROM vault_documents WHERE vault_id = {vaultId}))
            """, ct);
        await db.Database.ExecuteSqlAsync($"""
            DELETE FROM resource_permissions
            WHERE (resource_type = 'vault' AND resource_id = {vaultId})
               OR (resource_type = 'document' AND resource_id IN (SELECT doc_id FROM vault_documents WHERE vault_id = {vaultId}))
            """, ct);
        string folderPrefix = vaultId + ":";
        await db.Database.ExecuteSqlAsync($"DELETE FROM resource_permissions WHERE resource_type = 'folder' AND starts_with(resource_id, {folderPrefix})", ct);
        await db.Database.ExecuteSqlAsync($"DELETE FROM publications WHERE vault_id = {vaultId}", ct);
        await db.Database.ExecuteSqlAsync($"DELETE FROM edgesync_blobs WHERE vault_id = {vaultId}", ct);
        await db.Database.ExecuteSqlAsync($"DELETE FROM vault_key_wraps WHERE vault_id = {vaultId}", ct);
        await db.Database.ExecuteSqlAsync($"DELETE FROM vault_member_identities WHERE vault_id = {vaultId}", ct);

        // Jetons personnels limites a des vaults : celui-ci en sort. Un jeton
        // qui ne visait que lui est revoque (une liste vide voudrait dire
        // « tous les vaults »).
        List<AccessTokenEntity> tokens = await db.AccessTokens
            .Where(t => t.VaultIds != null && t.VaultIds.Contains(vaultId)).ToListAsync(ct);
        foreach (AccessTokenEntity token in tokens)
        {
            List<string> ids = token.VaultIds!.Split(',', StringSplitOptions.RemoveEmptyEntries).ToList();
            if (!ids.Remove(vaultId)) continue;
            if (ids.Count == 0) token.RevokedAt ??= DateTime.UtcNow;
            else token.VaultIds = string.Join(',', ids);
        }
        if (tokens.Count > 0) await db.SaveChangesAsync(ct);
    }

    private const string OrphanDocuments = "resource_id NOT IN (SELECT doc_id FROM vault_documents)";

    public async Task<OrphanReport> PurgeOrphansAsync(bool dryRun, CancellationToken ct = default)
    {
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var counts = new Dictionary<string, long>();

        async Task Run(string name, string where, string table)
        {
            // `where` et `table` sont des constantes de ce fichier, jamais une entree.
#pragma warning disable EF1002
            long n = dryRun
                ? await db.Database.SqlQueryRaw<long>($"SELECT count(*)::bigint AS \"Value\" FROM {table} WHERE {where}").SingleAsync(ct)
                : await db.Database.ExecuteSqlRawAsync($"DELETE FROM {table} WHERE {where}", ct);
#pragma warning restore EF1002
            counts[name] = counts.GetValueOrDefault(name) + n;
        }

        const string noVaultOfVaultOp = "resource_type = 'vault' AND substr(resource_id, 7) NOT IN (SELECT id FROM vaults)";
        const string noVaultOfIndexOp = "resource_type = 'index' AND split_part(resource_id, ':', 2) NOT IN (SELECT id FROM vaults)";
        await Run("operations", $"resource_type IN ('document', 'room') AND {OrphanDocuments}", "operations_log");
        await Run("operations", noVaultOfVaultOp, "operations_log");
        await Run("operations", noVaultOfIndexOp, "operations_log");
        await Run("syncVectors", """
            resource_id NOT IN (SELECT doc_id FROM vault_documents)
            AND NOT (resource_id LIKE 'vault:%' AND substr(resource_id, 7) IN (SELECT id FROM vaults))
            AND NOT (resource_id LIKE 'index:%' AND split_part(resource_id, ':', 2) IN (SELECT id FROM vaults))
            """, "sync_vectors");
        const string noResource = """
            (resource_type = 'vault' AND resource_id NOT IN (SELECT id FROM vaults))
            OR (resource_type = 'document' AND resource_id NOT IN (SELECT doc_id FROM vault_documents))
            """;
        await Run("shareLinks", noResource, "share_links");
        await Run("permissions", noResource, "resource_permissions");
        await Run("permissions", "resource_type = 'folder' AND split_part(resource_id, ':', 1) NOT IN (SELECT id FROM vaults)", "resource_permissions");
        const string noVault = "vault_id NOT IN (SELECT id FROM vaults)";
        await Run("publications", noVault, "publications");
        await Run("edgesyncBlobs", noVault, "edgesync_blobs");
        await Run("keyWraps", noVault, "vault_key_wraps");
        await Run("memberIdentities", noVault, "vault_member_identities");

        // Dossiers de fichiers sans vault.
        HashSet<string> known = (await db.Vaults.AsNoTracking().Select(v => v.Id).ToListAsync(ct)).ToHashSet();
        var folders = (await files.ListVaultIdsAsync(ct)).Where(id => !known.Contains(id)).ToList();
        long bytes = 0;
        foreach (string id in folders) bytes += await files.GetVaultBytesAsync(id, ct);

        if (dryRun) await tx.RollbackAsync(ct);
        else
        {
            await tx.CommitAsync(ct);
            foreach (string id in folders) await files.DeleteVaultAsync(id, ct);
        }
        return new OrphanReport(dryRun, counts, folders.Count, bytes);
    }
}
