// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
namespace Savoire.Domain.Aggregates;

/// <summary>
/// Resource type for a CRDT op-log entry. The op bytes are opaque to the server
/// (format-agnostic relay); this enum documents the payload contract per type so
/// readers/migrations never mis-handle a row.
/// </summary>
public static class CrdtResourceType
{
    /// <summary>Document text. OpBytes = binary Yjs update / state snapshot.</summary>
    public const string Document = "document";

    /// <summary>Vault directory. OpBytes = binary Yjs update / state snapshot.</summary>
    public const string Vault    = "vault";

    /// <summary>Snapshot-based plugin room (excalidraw, mindmap). OpBytes = UTF-8 JSON snapshot.</summary>
    public const string Room     = "room";

    /// <summary>Index partagé d'un namespace. OpBytes = binary Yjs update.
    /// Le serveur n'interprète rien : il empile et rediffuse. ResourceId =
    /// "index:{vaultId}:{namespace}".</summary>
    public const string Index    = "index";
}
