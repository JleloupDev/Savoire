// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Ecriture du flux de changements du pair indexeur (ADR-027,
// docs/Architecture/indexer-protocol.md).
//
// Appele par les repositories qui ecrivent, DANS leur transaction : le
// changement est visible en meme temps que l'ecriture, ou pas du tout. Le
// journal CRDT (EfCrdtOpRepository) est le seul a ecrire dans operations_log :
// tous les chemins (hubs du vault, des documents, des rooms, compactions)
// passent donc par ici.
//
// Une ligne par ressource : INSERT OR REPLACE supprime l'ancienne ligne et en
// cree une neuve, dont la sequence (AUTOINCREMENT) est plus grande que toutes
// celles jamais attribuees. SQLite n'a qu'un ecrivain a la fois et la
// sequence est attribuee dans la transaction d'ecriture : l'ordre des
// sequences est l'ordre des validations. Un lecteur qui a vu la sequence N ne
// verra jamais apparaitre plus tard une sequence plus petite.

using Microsoft.EntityFrameworkCore;
using Savoire.Domain.Aggregates;
using Savoire.Domain.ReadModels;

namespace Savoire.Infrastructure.Persistence;

internal static class IndexerChangeWriter
{
    private const string VaultResourcePrefix = "vault:";

    /// <summary>Une ecriture dans le journal CRDT : arborescence ou document.</summary>
    public static async Task RecordOperationAsync(AppDbContext db, string resourceType, string resourceId, CancellationToken ct)
    {
        DateTime now = DateTime.UtcNow;
        switch (resourceType)
        {
            case CrdtResourceType.Vault:
                if (!resourceId.StartsWith(VaultResourcePrefix, StringComparison.Ordinal)) return;
                await RecordVaultAsync(db, resourceId[VaultResourcePrefix.Length..], ct);
                return;

            // Une room (document « snapshot » : tableau...) est un document comme un autre.
            case CrdtResourceType.Document:
            case CrdtResourceType.Room:
                // Le vault vient du registre « document -> vault » ; un document
                // non inscrit n'a pas de vault connu : pas de ligne.
                string key = $"{IndexerChangeKind.Document}:{resourceId}";
                await db.Database.ExecuteSqlAsync($"""
                    INSERT OR REPLACE INTO indexer_changes (resource_key, vault_id, kind, doc_id, changed_at)
                    SELECT {key}, vault_id, {IndexerChangeKind.Document}, doc_id, {now}
                    FROM vault_documents WHERE doc_id = {resourceId}
                    """, ct);
                return;

            // Canaux d'index partages : ce ne sont ni des documents ni l'arborescence.
            default:
                return;
        }
    }

    /// <summary>L'arborescence du vault a change (ou le vault entre dans le pair gere).</summary>
    public static async Task RecordVaultAsync(AppDbContext db, string vaultId, CancellationToken ct)
    {
        string key = $"{IndexerChangeKind.Vault}:{vaultId}";
        DateTime now = DateTime.UtcNow;
        await db.Database.ExecuteSqlAsync($"""
            INSERT OR REPLACE INTO indexer_changes (resource_key, vault_id, kind, doc_id, changed_at)
            VALUES ({key}, {vaultId}, {IndexerChangeKind.Vault}, NULL, {now})
            """, ct);
    }

    /// <summary>
    /// Le vault est supprime ou sort du pair gere : une ligne « vault-deleted »,
    /// et ses autres lignes disparaissent (supprime) ou restent en attente
    /// (sorti du pair gere : elles sont filtrees tant qu'il n'y revient pas).
    /// </summary>
    public static async Task RecordVaultGoneAsync(AppDbContext db, string vaultId, bool purgeRows, CancellationToken ct)
    {
        string key = $"{IndexerChangeKind.VaultDeleted}:{vaultId}";
        DateTime now = DateTime.UtcNow;
        await db.Database.ExecuteSqlAsync($"""
            INSERT OR REPLACE INTO indexer_changes (resource_key, vault_id, kind, doc_id, changed_at)
            VALUES ({key}, {vaultId}, {IndexerChangeKind.VaultDeleted}, NULL, {now})
            """, ct);
        if (purgeRows)
        {
            await db.Database.ExecuteSqlAsync($"""
                DELETE FROM indexer_changes WHERE vault_id = {vaultId} AND kind <> {IndexerChangeKind.VaultDeleted}
                """, ct);
        }
    }

    /// <summary>Transaction propre si l'appelant n'en a pas ouvert ; null sinon (la sienne sert).</summary>
    public static async Task<Microsoft.EntityFrameworkCore.Storage.IDbContextTransaction?> BeginIfNoneAsync(
        AppDbContext db, CancellationToken ct) =>
        db.Database.CurrentTransaction is null ? await db.Database.BeginTransactionAsync(ct) : null;
}
