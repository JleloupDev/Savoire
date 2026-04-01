// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
export enum ReplicationMode {
  LocalOnly = 'local_only',
  RemoteOnly = 'remote_only',
  Bidirectional = 'bidirectional',
}

export enum ConnectivityState {
  Offline = 'offline',
  Connecting = 'connecting',
  Online = 'online',
}

export enum SyncState {
  NotInitialized = 'not_initialized',
  InSync = 'in_sync',
  LocalPending = 'local_pending',
  Conflict = 'conflict',
  Error = 'error',
}

export enum UpdateSource {
  Local = 'local',
  Remote = 'remote',
}
