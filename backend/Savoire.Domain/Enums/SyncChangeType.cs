// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
namespace Savoire.Domain.Enums;

/// <summary>Type of change observed on a document during a sync diff.</summary>
public enum SyncChangeType
{
    Created,
    Modified,
    Deleted,
    /// <summary>Reserved — not yet produced by the server.</summary>
    Moved
}

public static class SyncChangeTypeExtensions
{
    public static string ToApiString(this SyncChangeType ct) => ct switch
    {
        SyncChangeType.Created  => "created",
        SyncChangeType.Modified => "modified",
        SyncChangeType.Deleted  => "deleted",
        SyncChangeType.Moved    => "moved",
        _                       => throw new ArgumentOutOfRangeException(nameof(ct), ct, null)
    };

    public static SyncChangeType ParseSyncChangeType(this string s) => s switch
    {
        "created"  => SyncChangeType.Created,
        "modified" => SyncChangeType.Modified,
        "deleted"  => SyncChangeType.Deleted,
        "moved"    => SyncChangeType.Moved,
        _          => throw new ArgumentException($"Unknown SyncChangeType: '{s}'")
    };
}
