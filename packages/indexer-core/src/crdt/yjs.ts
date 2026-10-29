// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Rejouer un journal Yjs (mises a jour binaires ou en base 64, telles que
// l'API interne du backend les rend) dans un Y.Doc neuf. Le Y.Doc est a
// liberer (destroy) apres lecture : le pair ne garde jamais 10 000 documents
// en memoire.
import * as Y from 'yjs'

export type YjsUpdate = string | Uint8Array

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Un Y.Doc avec ces mises a jour appliquees, dans l'ordre. */
export function loadDoc(updates: readonly YjsUpdate[]): Y.Doc {
  const doc = new Y.Doc()
  doc.transact(() => {
    for (const u of updates) Y.applyUpdate(doc, typeof u === 'string' ? fromBase64(u) : u)
  })
  return doc
}

/** Lit un journal puis libere le document. */
export function withDoc<T>(updates: readonly YjsUpdate[], read: (doc: Y.Doc) => T): T {
  const doc = loadDoc(updates)
  try {
    return read(doc)
  } finally {
    doc.destroy()
  }
}
