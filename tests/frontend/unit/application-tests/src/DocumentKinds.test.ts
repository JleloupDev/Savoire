// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Documents anciens : un CRDT autre que le Markdown recoit sa nature depuis le
// type de son plugin, quand il est la. Le reste : rien.
import { describe, it, expect, vi } from 'vitest'
import { recordDocumentKinds, watchDocumentKinds } from '@savoire/application'
import type { DocumentSyncKind, IDocumentMeta } from '@savoire/platform'

/** Repertoire minimal : entrees, nature, signal de changement. */
class FakeDirectory {
  private readonly docs = new Map<string, IDocumentMeta>()
  private readonly listeners = new Set<() => void>()
  getAll(): IDocumentMeta[] { return [...this.docs.values()] }
  getById(id: string) { return this.docs.get(id) }
  add(d: IDocumentMeta): void { this.docs.set(d.id, { ...d }); this.emit() }
  setKind(id: string, kind: DocumentSyncKind): void { const d = this.docs.get(id); if (d) { d.kind = kind; this.emit() } }
  onChange(cb: () => void): () => void { this.listeners.add(cb); return () => this.listeners.delete(cb) }
  private emit(): void { for (const cb of this.listeners) cb() }
}

const types = (path: string) => (path.endsWith('.wtf') ? 'crdt' as const : path.endsWith('.mm') ? 'snapshot' as const : undefined)

function vault() {
  const d = new FakeDirectory()
  d.add({ id: 'w', path: 'Essai.wtf' })
  d.add({ id: 'm', path: 'Carte.mm' })
  d.add({ id: 'n', path: 'Note.md' })
  d.add({ id: 'i', path: 'Images/logo.png' })
  d.add({ id: 'u', path: 'Inconnu.zzz' })
  d.add({ id: 'k', path: 'Deja.wtf', kind: 'snapshot' })
  return d
}

describe('natures des documents anciens', () => {
  it('enregistre les CRDT dont le type est connu ; le reste ne bouge pas', () => {
    const d = vault()
    expect(recordDocumentKinds(d, types)).toBe(1)
    const kinds = Object.fromEntries(d.getAll().map(x => [x.id, x.kind]))
    // Un instantane (.mm) se lit deja comme tel sans plugin : rien a enregistrer.
    expect(kinds).toEqual({ w: 'crdt', m: undefined, n: undefined, i: undefined, u: undefined, k: 'snapshot' })
    // Deuxieme passage : plus rien a faire.
    expect(recordDocumentKinds(d, types)).toBe(0)
  })

  it('suit le repertoire, regroupe, et ne touche a rien pour un lecteur', async () => {
    vi.useFakeTimers()
    try {
      const d = vault()
      let writer = false
      const stop = watchDocumentKinds(d, types, () => writer, 100)
      vi.advanceTimersByTime(150)
      expect(d.getById('w')?.kind).toBeUndefined()
      writer = true
      d.add({ id: 'w2', path: 'Autre.wtf' })
      vi.advanceTimersByTime(150)
      expect(d.getById('w')?.kind).toBe('crdt')
      expect(d.getById('w2')?.kind).toBe('crdt')
      stop()
      d.add({ id: 'w3', path: 'Encore.wtf' })
      vi.advanceTimersByTime(150)
      expect(d.getById('w3')?.kind).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})
