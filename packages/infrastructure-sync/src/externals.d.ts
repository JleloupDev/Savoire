// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
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
