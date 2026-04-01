// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
declare module '@microsoft/signalr' {
  export enum HubConnectionState {
    Disconnected = 'Disconnected',
    Connecting = 'Connecting',
    Connected = 'Connected',
    Reconnecting = 'Reconnecting',
    Disconnecting = 'Disconnecting',
  }

  export enum LogLevel {
    None = 6,
  }

  export interface IHttpConnectionOptions {
    accessTokenFactory?: () => string
  }

  export class HubConnection {
    readonly state: HubConnectionState
    start(): Promise<void>
    stop(): Promise<void>
    invoke<T = unknown>(methodName: string, ...args: unknown[]): Promise<T>
    on(methodName: string, newMethod: (...args: any[]) => void): void
    onreconnected(callback: (connectionId?: string) => void): void
  }

  export class HubConnectionBuilder {
    withUrl(url: string, options?: IHttpConnectionOptions): HubConnectionBuilder
    configureLogging(logLevel: LogLevel): HubConnectionBuilder
    withAutomaticReconnect(): HubConnectionBuilder
    build(): HubConnection
  }
}

declare module 'yjs' {
  export class Doc {
    getText(name: string): Text
  }

  export class Text {
    insert(index: number, content: string): void
    toString(): string
  }

  export function applyUpdate(doc: Doc, update: Uint8Array): void
}
