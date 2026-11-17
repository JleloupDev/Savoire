// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Bulles : un document mis de cote pour l'ouvrir d'un clic, sans onglet,
// dans une petite fenetre flottante (comme les bulles de discussion d'une
// messagerie). Pratique pour une discussion qu'on garde sous la main.
//
// Une liste par compte et par vault, gardee dans ce navigateur. On garde
// l'id du document : renommer ou deplacer la note ne perd pas sa bulle.

export interface Bubble {
  docId: string
  /** Chemin connu a la mise en bulle (remplace par le chemin a jour a l'affichage). */
  path: string
}

/** Au plus : au-dela, la plus ancienne part. */
export const MAX_BUBBLES = 8

type Listener = () => void

export class BubbleStore {
  private scope = ''
  private items: Bubble[] = []
  private open: string | null = null
  private readonly listeners = new Set<Listener>()

  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = typeof localStorage !== 'undefined' ? localStorage : null) {}

  private key(): string { return `savoire.bubbles.${this.scope}` }

  /** Compte et vault courants : recharge leur liste. */
  setScope(userId: string | undefined, vaultId: string | undefined): void {
    const next = userId && vaultId ? `${userId}.${vaultId}` : ''
    if (next === this.scope) return
    this.scope = next
    this.open = null
    this.items = []
    if (next && this.storage) {
      try {
        const raw = JSON.parse(this.storage.getItem(this.key()) ?? '[]') as unknown
        if (Array.isArray(raw)) {
          this.items = raw.filter((b): b is Bubble => typeof b?.docId === 'string' && typeof b?.path === 'string').slice(-MAX_BUBBLES)
        }
      } catch { /* liste illisible : vide */ }
    }
    this.emit()
  }

  list(): Bubble[] { return [...this.items] }
  has(docId: string): boolean { return this.items.some(b => b.docId === docId) }
  opened(): string | null { return this.open }

  add(docId: string, path: string, openNow = false): void {
    if (!this.scope) return
    if (!this.has(docId)) {
      this.items.push({ docId, path })
      while (this.items.length > MAX_BUBBLES) this.items.shift()
      this.save()
    }
    if (openNow) this.open = docId
    this.emit()
  }

  remove(docId: string): void {
    this.items = this.items.filter(b => b.docId !== docId)
    if (this.open === docId) this.open = null
    this.save()
    this.emit()
  }

  /** Ouvre une bulle (une seule a la fois), ou la referme si elle l'etait. */
  toggle(docId: string): void {
    this.open = this.open === docId ? null : docId
    this.emit()
  }

  close(): void {
    if (this.open === null) return
    this.open = null
    this.emit()
  }

  subscribe(cb: Listener): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  private save(): void {
    if (!this.scope || !this.storage) return
    try { this.storage.setItem(this.key(), JSON.stringify(this.items)) } catch { /* stockage plein ou interdit */ }
  }

  private emit(): void { for (const cb of this.listeners) cb() }
}

/** Les bulles de l'application. */
export const bubbles = new BubbleStore()
