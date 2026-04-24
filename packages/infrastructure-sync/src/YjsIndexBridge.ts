// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import * as Y from 'yjs'
import type { IndexEngine } from '@savoire/domain-index'
import { YjsCollaborativeText } from './YjsCollaborativeText'

// DECISION: Y.Text.observe/unobserve types are not reachable via the Yjs
// .js→.d.ts chain in TS 5.9 + moduleResolution:bundler. Use ydoc's update
// event instead — fires for any change in the doc, equivalent for single-text docs.
type YDocAny = Y.Doc & { on(event: string, handler: (...args: unknown[]) => void): void; off(event: string, handler: (...args: unknown[]) => void): void }

// Bridges Y.Doc update events to IndexEngine.onTextChange.
// Returns a cleanup function to stop observing.
export class YjsIndexBridge {
  constructor(private readonly engine: IndexEngine) {}

  attach(ydoc: Y.Doc, docId: string): () => void {
    const ytext = ydoc.getText('content')
    const handler = () => {
      const text = new YjsCollaborativeText(ytext, ydoc)
      this.engine.onTextChange(text, docId)
    }
    const doc = ydoc as YDocAny
    doc.on('update', handler)
    return () => doc.off('update', handler)
  }
}
