// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Mock for @microsoft/signalr (CJS module that breaks ESM/vitest barrel imports)
export const HubConnectionState = {
  Disconnected: 'Disconnected',
  Connecting: 'Connecting',
  Connected: 'Connected',
  Disconnecting: 'Disconnecting',
  Reconnecting: 'Reconnecting',
}

export class HubConnectionBuilder {
  withUrl(_url: string, _options?: unknown) { return this }
  withAutomaticReconnect() { return this }
  build() {
    return {
      start: async () => {},
      stop: async () => {},
      on: (_method: string, _callback: (...args: unknown[]) => void) => {},
      off: (_method: string) => {},
      send: async (_method: string, ..._args: unknown[]) => {},
      state: HubConnectionState.Disconnected,
    }
  }
}
