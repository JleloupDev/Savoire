// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Snapshot d'un index plugin — sérialisé périodiquement par le client,
// stocké côté serveur pour éviter le bootstrap complet aux nouveaux clients.
// Modèle M1 : ops + snapshots avec serveur comme séquenceur.

namespace Savoire.Domain.Aggregates;

public sealed class IndexSnapshot
{
    public string   Id           { get; private set; } = null!;
    public string   VaultId      { get; private set; } = null!;
    public string   Namespace    { get; private set; } = null!; // ex: "plugin-dataview.fields"
    public long     ProcessedSeq { get; private set; }           // dernier seq traité
    public string   Data         { get; private set; } = null!; // JSON libre, défini par le plugin
    public DateTime CreatedAt    { get; private set; }

    private IndexSnapshot() { }

    public static IndexSnapshot Create(
        string vaultId, string @namespace, long processedSeq, string data) => new()
    {
        Id           = Guid.NewGuid().ToString(),
        VaultId      = vaultId,
        Namespace    = @namespace,
        ProcessedSeq = processedSeq,
        Data         = data,
        CreatedAt    = DateTime.UtcNow,
    };

    // FOR_PERSISTENCE_ONLY
    public static IndexSnapshot Rehydrate(
        string id, string vaultId, string @namespace,
        long processedSeq, string data, DateTime createdAt) => new()
    {
        Id           = id,
        VaultId      = vaultId,
        Namespace    = @namespace,
        ProcessedSeq = processedSeq,
        Data         = data,
        CreatedAt    = createdAt,
    };
}
