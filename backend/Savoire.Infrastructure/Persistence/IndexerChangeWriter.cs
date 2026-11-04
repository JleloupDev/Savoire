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
// Une ligne par ressource : on supprime l'ancienne ligne et on en cree une
// neuve, dont la sequence (identite PostgreSQL) est plus grande que toutes
// celles jamais attribuees.
//
// L'ordre des sequences doit etre l'ordre des validations : un lecteur qui a
// vu la sequence N ne doit jamais voir apparaitre plus tard une sequence plus
// petite. PostgreSQL attribue une sequence a l'insertion, pas a la
// validation : deux transactions peuvent valider dans le desordre. D'ou un
// verrou transactionnel (pg_advisory_xact_lock) pris juste avant d'ecrire
// dans le flux et rendu a la validation : les ecritures du flux passent une a
// une, comme sous SQLite. Avec plusieurs instances de l'API, le verrou vaut
// pour toutes (il est dans la base).

using Microsoft.EntityFrameworkCore;
using Savoire.Domain.Aggregates;
using Savoire.Domain.ReadModels;

namespace Savoire.Infrastructure.Persistence;

internal static class IndexerChangeWriter
{
    private const string VaultResourcePrefix = "vault:";
    private const string IndexResourcePrefix = "index:";

    /// <summary>Cle du verrou du flux (pg_advisory_xact_lock) : « SAVOIRE1 » en ASCII.</summary>
    private const long FeedLockKey = 0x5341_564F_4952_4531;

    /// <summary>
    /// Remplace la ligne de <paramref name="key"/> par une neuve (sequence neuve),
    /// verrou du flux tenu jusqu'a la validation. Toujours dans une transaction.
    /// </summary>
    private static async Task ReplaceAsync(AppDbContext db, string key, FormattableString insert, CancellationToken ct)
    {
        if (db.Database.CurrentTransaction is null)
            throw new InvalidOperationException("Flux du pair indexeur : ecriture hors transaction.");
        await db.Database.ExecuteSqlAsync($"SELECT pg_advisory_xact_lock({FeedLockKey})", ct);
        await db.Database.ExecuteSqlAsync($"DELETE FROM indexer_changes WHERE resource_key = {key}", ct);
        await db.Database.ExecuteSqlAsync(insert, ct);
    }

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
                // Un annexe jamais inscrit (lot d'une base cree avant le
                // registre) : le vault de son document (AnnexDocuments).
                string key = $"{IndexerChangeKind.Document}:{resourceId}";
                string parent = AnnexDocuments.ParentOf(resourceId) ?? resourceId;
                string? docVault = await db.Database.SqlQuery<string>($"""
                    SELECT vault_id AS "Value"
                    FROM vault_documents
                    WHERE doc_id = {resourceId}
                       OR (doc_id = {parent} AND NOT EXISTS (SELECT 1 FROM vault_documents WHERE doc_id = {resourceId}))
                    LIMIT 1
                    """).FirstOrDefaultAsync(ct);
                if (docVault is null) return;
                await ReplaceAsync(db, key, $"""
                    INSERT INTO indexer_changes (resource_key, vault_id, kind, doc_id, changed_at)
                    VALUES ({key}, {docVault}, {IndexerChangeKind.Document}, {resourceId}, {now})
                    """, ct);
                return;

            // Canaux d'index partages : seuls les reglages lus par le pair
            // (types des proprietes) l'interessent. ResourceId =
            // "index:{vaultId}:settings/{section}".
            case CrdtResourceType.Index:
                if (SettingsVaultOf(resourceId) is not { } vaultId) return;
                string settingsKey = $"{IndexerChangeKind.Settings}:{vaultId}";
                await ReplaceAsync(db, settingsKey, $"""
                    INSERT INTO indexer_changes (resource_key, vault_id, kind, doc_id, changed_at)
                    VALUES ({settingsKey}, {vaultId}, {IndexerChangeKind.Settings}, NULL, {now})
                    """, ct);
                return;

            default:
                return;
        }
    }

    /// <summary>Vault d'un canal de reglages lu par le pair ; null pour tout autre canal.</summary>
    internal static string? SettingsVaultOf(string resourceId)
    {
        if (!resourceId.StartsWith(IndexResourcePrefix, StringComparison.Ordinal)) return null;
        int sep = resourceId.IndexOf(':', IndexResourcePrefix.Length);
        if (sep <= IndexResourcePrefix.Length) return null;
        string ns = resourceId[(sep + 1)..];
        const string prefix = "settings/";
        if (!ns.StartsWith(prefix, StringComparison.Ordinal) || !IndexerChangeKind.SettingsSections.Contains(ns[prefix.Length..])) return null;
        return resourceId[IndexResourcePrefix.Length..sep];
    }

    /// <summary>L'arborescence du vault a change (ou le vault entre dans le pair gere).</summary>
    public static async Task RecordVaultAsync(AppDbContext db, string vaultId, CancellationToken ct)
    {
        string key = $"{IndexerChangeKind.Vault}:{vaultId}";
        DateTime now = DateTime.UtcNow;
        await ReplaceAsync(db, key, $"""
            INSERT INTO indexer_changes (resource_key, vault_id, kind, doc_id, changed_at)
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
        await ReplaceAsync(db, key, $"""
            INSERT INTO indexer_changes (resource_key, vault_id, kind, doc_id, changed_at)
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
