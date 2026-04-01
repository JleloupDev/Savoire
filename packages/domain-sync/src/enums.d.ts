// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
export declare enum ReplicationMode {
    LocalOnly = "local_only",
    RemoteOnly = "remote_only",
    Bidirectional = "bidirectional"
}
export declare enum ConnectivityState {
    Offline = "offline",
    Connecting = "connecting",
    Online = "online"
}
export declare enum SyncState {
    NotInitialized = "not_initialized",
    InSync = "in_sync",
    LocalPending = "local_pending",
    Conflict = "conflict",
    Error = "error"
}
export declare enum UpdateSource {
    Local = "local",
    Remote = "remote"
}
//# sourceMappingURL=enums.d.ts.map