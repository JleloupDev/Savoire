// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup

namespace Savoire.Application.Sync.Common;

/// <summary>
/// Assigns a monotonically increasing sequence number to index ops.
/// Thread-safe via Interlocked. Singleton — injected into VaultHub.
/// </summary>
public sealed class IndexOpSequencer
{
    private long _seq = 0;

    public long Next() => Interlocked.Increment(ref _seq);
}
