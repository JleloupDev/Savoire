// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Mode local : sans arbre partage (pas de session de vault), la page est lue
// et ecrite comme un fichier JSON via le VaultAPI, avec anti-rebond.
//
// Le Y.Doc prive reste la source de l'editeur. Le contenu lu est pose sous
// NOTRE origine Yjs et n'est jamais reecrit : on n'ecrit qu'apres un
// changement venu de l'editeur, et seulement si le JSON a vraiment change.
import * as Y from 'yjs'
import type { VaultAPI } from '@savoire/plugin-api'
import { fragmentToPm, pmToInit, replaceFragment } from './convert'
import { parsePageFile, stringifyPageFile } from './pageFile'

export const SAVE_DEBOUNCE_MS = 800

export interface VaultMirrorOptions {
  debounceMs?: number
  /** Appele apres chaque ecriture, avec le contenu ecrit. */
  onSaved?: (raw: string) => void
  onError?: (err: unknown) => void
}

type PageVault = Pick<VaultAPI, 'readDocumentByPath' | 'write' | 'resolveDocumentId'>

export class VaultMirror {
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastSaved: string | null = null
  private loaded = false
  private readonly onUpdate = (_u: Uint8Array, origin: unknown) => {
    if (origin === this || !this.loaded) return
    this.schedule()
  }

  constructor(
    private readonly fragment: Y.XmlFragment,
    private readonly vault: PageVault,
    private readonly path: string,
    private readonly options: VaultMirrorOptions = {},
  ) {}

  /**
   * Lit le fichier et le pose dans le Y.Doc. Leve PageFileError si le
   * fichier est illisible : la vue passe alors en lecture seule, sans
   * jamais l'ecraser.
   */
  async load(): Promise<void> {
    const raw = await this.vault.readDocumentByPath(this.path)
    const doc = parsePageFile(raw)
    if (doc) {
      this.fragment.doc!.transact(() => replaceFragment(this.fragment, pmToInit(doc)), this)
    }
    this.lastSaved = stringifyPageFile(fragmentToPm(this.fragment))
    this.loaded = true
    this.fragment.doc!.on('update', this.onUpdate)
  }

  /** Ecrit tout de suite ce qui attend, et arrete d'ecouter. */
  async destroy(): Promise<void> {
    this.fragment.doc?.off('update', this.onUpdate)
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
      await this.flush()
    }
  }

  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, this.options.debounceMs ?? SAVE_DEBOUNCE_MS)
  }

  /** Ecrit si le contenu a change depuis la lecture ou la derniere ecriture. */
  async flush(): Promise<void> {
    const content = stringifyPageFile(fragmentToPm(this.fragment))
    if (content === this.lastSaved) return
    const docId = this.vault.resolveDocumentId(this.path)
    if (!docId) {
      this.options.onError?.(new Error(`Document introuvable : ${this.path}`))
      return
    }
    this.lastSaved = content
    try {
      await this.vault.write(docId, content)
      this.options.onSaved?.(content)
    } catch (err) {
      this.lastSaved = null
      this.options.onError?.(err)
    }
  }
}
