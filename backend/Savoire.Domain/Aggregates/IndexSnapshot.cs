// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Plugin index snapshot — serialized periodically by the client,
// stored server-side to avoid a full bootstrap for new clients.
// M1 model: ops + snapshots with the server as sequencer.

namespace Savoire.Domain.Aggregates;

public sealed class IndexSnapshot
{
    public string   Id           { get; private set; } = null!;
    public string   VaultId      { get; private set; } = null!;
    public string   Namespace    { get; private set; } = null!; // e.g. "plugin-dataview.fields"
    public long     ProcessedSeq { get; private set; }           // last processed seq
    public string   Data         { get; private set; } = null!; // free-form JSON defined by the plugin
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
