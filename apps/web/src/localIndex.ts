// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Index SQLite LOCAL du vault ouvert (ADR-027, etape 6), branche sur les
// fournisseurs de l'appli quand aucun pair indexeur ne sert le vault :
//
//  - bureau, vault du disque : SQLite natif (Rust), `.savoire/index.sqlite`,
//    et indexeur de fond de TOUT le dossier. Requetes, recherche et pouvoirs
//    (links, tags, index) passent par lui ;
//  - navigateur, profil `local` (pair a pair) : SQLite WebAssembly dans un
//    Worker, persiste dans l'OPFS. Il recoit les metadonnees partagees de
//    toutes les notes et le texte des notes ouvertes ou lues ici : requetes
//    et recherche passent par lui ; pas les pouvoirs `links` et `tags`
//    (il ne connait pas le texte de tout le vault), le rattrapage des notes
//    jamais indexees continue (moteur `partial`) ;
//  - vault servi par un pair indexeur (profil serveur) : rien ici
//    (indexerServices.ts).
//
// Les lignes legeres des bases arrivent par le miroir du fournisseur de
// requetes (lots qu'il ouvre). Le moteur en memoire reste le secours : index
// local en echec ou indisponible, l'appli continue sans lui.
import type {
  IQueryIndexMirror, IVaultSyncSession, IndexerPowersProvider, QueryEngineProvider, SearchEngineProvider,
} from '@savoire/application'
import { BaseRowFeeder, SharedIndexFeeder, WorkerLocalIndex } from '@savoire/indexer-core/local'
import type { ILocalIndex } from '@savoire/indexer-core/local'
import { notify } from '@savoire/notifications'
import { getActiveProfile, getDesktopProfile } from './profile'

/** Un index local ouvert et ce qui le nourrit. */
export interface LocalIndexBinding {
  kind: 'native' | 'wasm'
  index: ILocalIndex
  mirror: IQueryIndexMirror
  /** Lance la premiere passe (apres branchement). */
  start(): void
  /** Texte complet d'une note (editeur, lecture hors editeur). */
  noteText(id: string, path: string, content: string): void
  dispose(): Promise<void>
}

export interface LocalIndexDeps {
  query: QueryEngineProvider
  search: SearchEngineProvider
  powers: IndexerPowersProvider
}

/** Navigateur, pair a pair : l'index dans un Worker, nourri par les metadonnees partagees. */
async function openWasmLocalIndex(session: IVaultSyncSession, vaultId: string): Promise<LocalIndexBinding> {
  const worker = new Worker(new URL('./localIndexWorker.ts', import.meta.url), { type: 'module', name: 'savoire-index' })
  let index: WorkerLocalIndex | null = null
  worker.addEventListener('error', e => {
    console.warn('[index local] Worker en echec', e.message)
    index?.fail()
  })
  index = await WorkerLocalIndex.open(worker, { name: vaultId, persistence: 'opfs' }, { dispose: () => worker.terminate() })
  const opened = index
  if (opened.info.persistence !== 'opfs') {
    console.info('[index local] index en memoire', opened.info.note)
    notify('info', 'Index local en mémoire',
      'Ce navigateur ne permet pas de garder l\'index du vault (navigation privée, ou autre onglet de Savoire ouvert). Il sera refait au prochain chargement.')
  }
  const feeder = new SharedIndexFeeder(opened, {
    // Une erreur (pair absent...) n'efface pas le texte : la note est relue plus tard.
    readText: id => session.readDocument(id, 'crdt'),
  })
  const rows = new BaseRowFeeder(opened)
  return {
    kind: 'wasm',
    index: opened,
    mirror: {
      notes: docs => feeder.setNotes(docs),
      lot: (baseId, lot, lotCount, docs) => rows.lot(baseId, lot, lotCount, docs),
      rows: (upserts, removed) => rows.rows(upserts, removed),
    },
    start: () => {},
    noteText: (id, path, content) => feeder.noteText(id, path, content),
    dispose: async () => {
      feeder.dispose()
      await rows.whenIdle()
      await opened.close().catch(() => worker.terminate())
    },
  }
}

export class LocalIndexServices {
  private binding: LocalIndexBinding | null = null
  private closing: Promise<void> = Promise.resolve()
  private gen = 0
  /** Ce module a pose les moteurs preferes (a retirer au changement de vault). */
  private owns = false

  constructor(private readonly deps: LocalIndexDeps) {}

  /** L'index local du vault ouvert, s'il y en a un. */
  get current(): LocalIndexBinding | null {
    return this.binding
  }

  /**
   * Debranche l'index du vault precedent. A appeler AVANT de rebrancher le
   * fournisseur de requetes sur un autre vault (le miroir recevrait ses notes).
   */
  detach(): void {
    this.gen++
    this.deps.query.setMirror(null)
    if (this.owns) {
      this.deps.query.setPreferred(null)
      this.deps.search.setPreferred(null)
      this.deps.powers.setSource(null)
      this.owns = false
    }
    const old = this.binding
    this.binding = null
    if (old) this.closing = this.closing.then(() => old.dispose()).catch(err => console.warn('[index local] fermeture', err))
  }

  /** Branche l'index local du vault ouvert (apres le pair indexeur, qui passe avant). */
  attach(session: IVaultSyncSession | undefined, vaultId: string | undefined): void {
    this.detach()
    const gen = this.gen
    if (!session || !vaultId || session.indexer) return
    const desktop = getDesktopProfile()
    let open: (() => Promise<LocalIndexBinding | null>) | null = null
    if (desktop?.pathOfVault(vaultId)) {
      open = async () => (await import('./desktopLocalIndex')).openDesktopLocalIndex(session, vaultId)
    } else if (getActiveProfile().name === 'local' && typeof Worker !== 'undefined') {
      open = () => openWasmLocalIndex(session, vaultId)
    }
    if (!open) return
    void this.closing
      // Le Worker precedent rend d'abord ses poignees OPFS.
      .then(() => gen === this.gen ? open!() : null)
      .then(binding => {
        if (!binding) return
        if (gen !== this.gen) { void binding.dispose(); return }
        this.bind(binding)
      })
      .catch(err => console.warn('[index local] indisponible, moteur en memoire', err))
  }

  /** Texte complet d'une note (hook onDocumentStabilized, rattrapage). */
  noteText(id: string, path: string, content: string): void {
    this.binding?.noteText(id, path, content)
  }

  dispose(): void {
    this.detach()
  }

  private bind(binding: LocalIndexBinding): void {
    const { query, search, powers } = this.deps
    this.binding = binding
    this.owns = true
    query.setMirror(binding.mirror)
    query.setPreferred(binding.index.queryEngine(), { partial: binding.kind === 'wasm' })
    search.setPreferred(binding.index.searchEngine())
    // Pouvoirs de tout le vault : seulement un index qui a tout le vault.
    if (binding.kind === 'native') powers.setSource(binding.index)
    binding.start()
  }
}
