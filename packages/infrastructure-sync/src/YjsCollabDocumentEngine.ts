// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import * as Y from 'yjs'
import type { ApplyResult, ICollabDocumentEngine } from '@savoire/domain-sync'

export class YjsCollabDocumentEngine implements ICollabDocumentEngine {
  private readonly doc: Y.Doc
  private readonly text: Y.Text

  constructor(initialText = '') {
    this.doc = new Y.Doc()
    this.text = this.doc.getText('content')
    if (initialText) this.text.insert(0, initialText)
  }

  applyLocal(payload: Uint8Array): ApplyResult {
    Y.applyUpdate(this.doc, payload)
    return { text: this.text.toString(), versionDelta: 1 }
  }

  applyRemote(payload: Uint8Array): ApplyResult {
    Y.applyUpdate(this.doc, payload)
    return { text: this.text.toString(), versionDelta: 1 }
  }

  getText(): string {
    return this.text.toString()
  }
}
