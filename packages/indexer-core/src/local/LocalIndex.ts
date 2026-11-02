// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Index LOCAL d'un vault, vu de l'appli (ADR-027, etape 6) : le VaultIndex
// du noyau et la table des sources de l'hote. Deux realisations, une seule
// interface :
//  - DirectLocalIndex : dans le meme fil (bureau : SQL natif par Tauri ;
//    Worker du navigateur ; tests) ;
//  - WorkerLocalIndex (rpc.ts) : depuis le fil principal du navigateur, vers
//    un DirectLocalIndex qui tourne dans un Worker (SQLite WebAssembly).
//
// L'appli en tire ses moteurs (queryEngine, searchEngine) et les pouvoirs
// `links` et `tags` (call) ; un « nourrisseur » (bureau : les fichiers ;
// navigateur : les metadonnees partagees et le texte des notes ouvertes) y
// ecrit les notes avec la signature de leur source.
import type { IQueryEngine, ISearchEngine, IndexState } from '@savoire/plugin-api'
import type { SqlDriver } from '../driver'
import type { NoteInput, NoteRecord } from '../extract/note'
import type { MethodOptions } from '../power'
import { VaultIndex } from '../VaultIndex'
import type { VaultIndexOptions } from '../VaultIndex'
import { SourceTable } from './sources'

/** Ou vit l'index : fichier du bureau, OPFS du navigateur, ou memoire (perdu au rechargement). */
export type LocalPersistence = 'disk' | 'opfs' | 'memory'

export interface LocalIndexInfo {
  persistence: LocalPersistence
  /** L'index etait vide ou d'une autre version a l'ouverture : construction complete. */
  rebuildRequired: boolean
  /** Pourquoi la persistance n'est pas celle demandee (OPFS indisponible...). */
  note?: string
}

export interface ILocalIndex {
  readonly info: LocalIndexInfo
  /** Appel `capacite.methode` (protocole du pair indexeur) : links, tags, index... */
  call(capability: string, method: string, params: unknown, options?: MethodOptions): Promise<unknown>
  /** Indexe des notes (extraction comprise), puis note la signature de leur source. */
  applyDocs(inputs: readonly NoteInput[], sources?: Record<string, string>): Promise<void>
  /** Notes deja lues, lignes legeres de base ; puis signatures. */
  applyRecords(records: readonly NoteRecord[], sources?: Record<string, string>): Promise<void>
  /** Retire des notes ou des lignes (et leurs signatures). */
  removeDocs(ids: readonly string[]): Promise<void>
  /** Signatures des sources indexees : id -> signature. */
  sources(): Promise<Map<string, string>>
  /** id -> chemin des notes indexees (lignes de base exclues). */
  paths(): Promise<Map<string, string>>
  /** Ids des lignes legeres indexees d'une base. */
  rowIds(base: string): Promise<string[]>
  /** Tout le vault a ete indexe. */
  markBuilt(): Promise<void>
  setState(state: IndexState): void
  state(): IndexState
  onStateChange(cb: (state: IndexState) => void): () => void
  /** Prevenu apres chaque modification de l'index. */
  onChange(cb: () => void): () => void
  queryEngine(): IQueryEngine
  searchEngine(): ISearchEngine
  close(): Promise<void>
}

export interface DirectLocalIndexOptions extends VaultIndexOptions {
  persistence: LocalPersistence
  note?: string
}

export class DirectLocalIndex implements ILocalIndex {
  private constructor(
    readonly index: VaultIndex,
    private readonly table: SourceTable,
    readonly info: LocalIndexInfo,
  ) {}

  /** Ouvre l'index d'un vault sur un pilote. */
  static async open(driver: SqlDriver, options: DirectLocalIndexOptions): Promise<DirectLocalIndex> {
    const index = await VaultIndex.open(driver, options)
    const table = new SourceTable(driver)
    // Index a reconstruire : plus aucune signature ne vaut.
    await table.init(index.rebuildRequired)
    return new DirectLocalIndex(index, table, {
      persistence: options.persistence,
      rebuildRequired: index.rebuildRequired,
      ...(options.note ? { note: options.note } : {}),
    })
  }

  call(capability: string, method: string, params: unknown, options?: MethodOptions): Promise<unknown> {
    return this.index.call(capability, method, params, options)
  }

  async applyDocs(inputs: readonly NoteInput[], sources?: Record<string, string>): Promise<void> {
    await this.index.applyDocs(inputs)
    // Apres la note : une signature sans sa note ferait croire a une note a jour.
    if (sources) await this.table.set(sources)
  }

  async applyRecords(records: readonly NoteRecord[], sources?: Record<string, string>): Promise<void> {
    await this.index.applyRecords(records)
    if (sources) await this.table.set(sources)
  }

  async removeDocs(ids: readonly string[]): Promise<void> {
    if (!ids.length) return
    // La note d'abord (file du VaultIndex, dans l'ordre des appels), puis sa signature.
    await this.index.removeDocs(ids)
    await this.table.remove(ids)
  }

  sources(): Promise<Map<string, string>> {
    return this.table.all()
  }

  paths(): Promise<Map<string, string>> {
    return this.index.paths()
  }

  rowIds(base: string): Promise<string[]> {
    return this.index.rowIds(base)
  }

  markBuilt(): Promise<void> {
    return this.index.markBuilt()
  }

  setState(state: IndexState): void {
    this.index.setState(state)
  }

  state(): IndexState {
    return this.index.state()
  }

  onStateChange(cb: (state: IndexState) => void): () => void {
    return this.index.onStateChange(cb)
  }

  onChange(cb: () => void): () => void {
    return this.index.onChange(cb)
  }

  queryEngine(): IQueryEngine {
    return this.index.queryEngine()
  }

  searchEngine(): ISearchEngine {
    return this.index.searchEngine()
  }

  close(): Promise<void> {
    return this.index.close()
  }
}
