// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup

namespace Savoire.Application.Sync.Common;

/// <summary>
/// Assigne un numéro de séquence monotone croissant aux ops d'index.
/// Thread-safe via Interlocked. Singleton — injecté dans VaultHub.
/// </summary>
public sealed class IndexOpSequencer
{
    private long _seq = 0;

    public long Next() => Interlocked.Increment(ref _seq);
}
