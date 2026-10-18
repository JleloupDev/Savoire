// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Copie d'un vault d'une session a une autre : telecharger un vault du
// serveur sur le disque, envoyer un vault du disque au serveur. Le transfert
// ne sait pas laquelle des deux sessions est un serveur, un disque ou un pair :
// il ne parle qu'au port IVaultSyncSession.
//
// Ce qui est copie :
//   - le repertoire : documents avec leurs chemins, dossiers vides, corbeille
//     (la corbeille n'est qu'un prefixe de chemin, `.trash/`) ;
//   - les documents CRDT : leur etat COMPLET (readDocumentState), fusionne
//     dans la cible (mergeDocumentState). Une fusion est idempotente ;
//   - les documents snapshot : leur contenu ;
//   - les pieces jointes : leurs octets ;
//   - les cartes partagees connues (reglages du vault, revision, anciens
//     messages de discussion).
//
// Les identifiants des documents sont gardes : un aller-retour retrouve les
// memes documents. Seule exception, l'identifiant refuse par la cible (deja
// inscrit dans un autre vault du serveur) : le document en recoit un neuf,
// ou celui du document de meme chemin si la cible l'a deja (reprise).
//
// Un document n'apparait dans le repertoire de la cible qu'une fois son
// contenu en place : un transfert interrompu ne laisse pas de document vide.
// Relancer le transfert complete la copie sans rien dupliquer.
import {
  ATTACHMENTS_DIR, documentSyncKind, folderNoteOf, isAttachmentPath,
  type DocumentSyncKind, type IDocumentMeta,
} from '@savoire/platform'
import type { IIndexChannel } from '@savoire/plugin-api'
import { VaultGoneError, type IVaultSyncSession } from './contracts'

/** Une carte partagee attachee a des documents : `doc/<id>/<name>`. */
export interface DocumentMapSpec {
  /** Documents concernes, par extension (« .chat »). */
  extension: string
  name: string
}

export interface VaultTransferOptions {
  /** Famille de synchro d'un document (d'apres les types des plugins). Defaut : seul le Markdown est un CRDT. */
  syncKindOf?: (path: string) => DocumentSyncKind
  /** Le document est-il un fichier binaire (piece jointe) ? Defaut : les images. */
  isFile?: (path: string) => boolean
  /** Sections de reglages du vault a copier. Defaut : ['plugins']. */
  settingsSections?: readonly string[]
  /** Cartes partagees du vault a copier. Defaut : ['review']. */
  sharedMaps?: readonly string[]
  /** Cartes partagees par document a copier. Defaut : anciens messages des discussions. */
  documentMaps?: readonly DocumentMapSpec[]
  /** Nombre de documents copies en meme temps. Defaut : 4. */
  concurrency?: number
  /** Annulation : le document en cours se termine, les suivants ne partent pas. */
  signal?: AbortSignal
  onProgress?(progress: VaultTransferProgress): void
}

export type VaultTransferPhase = 'preparing' | 'documents' | 'maps' | 'finishing' | 'done'

export interface VaultTransferProgress {
  phase: VaultTransferPhase
  /** Elements traites (documents, dossiers, cartes) sur `total`. */
  done: number
  total: number
  /** Octets copies jusqu'ici (etats CRDT, contenus, fichiers). */
  bytes: number
  /** Chemin du dernier document traite. */
  current?: string
}

export interface VaultTransferError {
  /** Chemin du document, ou nom de la carte. */
  path: string
  message: string
}

export interface VaultTransferReport {
  /** Documents copies (ou fusionnes, pour un CRDT deja present). */
  copied: number
  /** Documents deja presents a l'identique dans la cible. */
  skipped: number
  /** Dossiers crees dans la cible. */
  folders: number
  /** Cartes partagees copiees. */
  maps: number
  bytes: number
  errors: VaultTransferError[]
  /** Identifiants changes (source -> cible), quand la cible a refuse l'original. */
  renamedIds: Record<string, string>
  /** Chemins changes (source -> cible), quand la cible avait un autre document a ce chemin. */
  renamedPaths: Record<string, string>
  cancelled: boolean
}

type EntryKind = DocumentSyncKind | 'file'

interface Plan {
  source: IDocumentMeta
  targetId: string
  targetPath: string
  kind: EntryKind
  /** Le document est deja dans le repertoire de la cible. */
  existing: boolean
}

const DEFAULT_DOCUMENT_MAPS: DocumentMapSpec[] = [{ extension: '.chat', name: 'messages' }]
const REGISTER_BATCH = 200

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Copie le vault de `source` dans `target`. Ne rejette que si l'une des deux
 * sessions perd son vault (VaultGoneError) ; toute autre erreur va au rapport.
 */
export async function transferVault(
  source: IVaultSyncSession,
  target: IVaultSyncSession,
  options: VaultTransferOptions = {},
): Promise<VaultTransferReport> {
  const syncKindOf = options.syncKindOf ?? documentSyncKind
  const isFile = options.isFile ?? isAttachmentPath
  const kindOf = (path: string): EntryKind => (isFile(path) ? 'file' : syncKindOf(path))
  const report: VaultTransferReport = {
    copied: 0, skipped: 0, folders: 0, maps: 0, bytes: 0, errors: [],
    renamedIds: {}, renamedPaths: {}, cancelled: false,
  }
  const progress: VaultTransferProgress = { phase: 'preparing', done: 0, total: 0, bytes: 0 }
  const emit = (patch: Partial<VaultTransferProgress> = {}): void => {
    Object.assign(progress, patch, { bytes: report.bytes })
    options.onProgress?.({ ...progress })
  }
  const aborted = (): boolean => {
    if (options.signal?.aborted) report.cancelled = true
    return report.cancelled
  }
  emit()

  // ── Preparation : identifiants et chemins dans la cible ───────────────────
  const docs = source.directory.getAll()
  const folders = source.directory.getFolders()
  const settingsSections = options.settingsSections ?? ['plugins']
  const sharedMaps = options.sharedMaps ?? ['review']
  const documentMaps = options.documentMaps ?? DEFAULT_DOCUMENT_MAPS
  const plans = await planDocuments(docs, target, kindOf, report)
  const perDocMaps = plans.flatMap(p => documentMaps
    .filter(spec => p.source.path.endsWith(spec.extension))
    .map(spec => ({ from: `doc/${p.source.id}/${spec.name}`, to: `doc/${p.targetId}/${spec.name}`, path: p.source.path })))
  const missingFolders = folders.filter(f => !target.directory.getFolders().includes(f))
  progress.total = plans.length + missingFolders.length + settingsSections.length + sharedMaps.length + perDocMaps.length
  emit({ phase: 'documents' })

  // ── Dossiers (vides ou non) ───────────────────────────────────────────────
  for (const folder of missingFolders) {
    if (aborted()) return report
    target.directory.addFolder(folder)
    report.folders++
    progress.done++
  }
  emit()

  // ── Documents ─────────────────────────────────────────────────────────────
  const queue = [...plans]
  const worker = async (): Promise<void> => {
    for (let plan = queue.shift(); plan; plan = queue.shift()) {
      if (aborted()) return
      try {
        const copied = await copyDocument(plan, source, target, report)
        if (copied) report.copied++
        else report.skipped++
        if (!plan.existing && !target.directory.getById(plan.targetId)) {
          // Le contenu est en place : le document peut apparaitre.
          target.directory.add({ id: plan.targetId, path: plan.targetPath })
        }
      } catch (err) {
        if (err instanceof VaultGoneError) throw err
        report.errors.push({ path: plan.source.path, message: message(err) })
      }
      progress.done++
      emit({ current: plan.source.path })
    }
  }
  const concurrency = Math.max(1, options.concurrency ?? 4)
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
  if (aborted()) return report
  await placeAttachments(plans, target)

  // ── Cartes partagees ──────────────────────────────────────────────────────
  emit({ phase: 'maps' })
  const remap = new Map(plans.filter(p => p.targetId !== p.source.id).map(p => [p.source.id, p.targetId]))
  const mapJobs = [
    ...settingsSections.map(s => ({ label: `reglages/${s}`, from: () => source.openVaultSettings(s), to: () => target.openVaultSettings(s) })),
    ...sharedMaps.map(n => ({ label: n, from: () => source.openSharedMap(n), to: () => target.openSharedMap(n) })),
    ...perDocMaps.map(m => ({ label: m.path, from: () => source.openSharedMap(m.from), to: () => target.openSharedMap(m.to) })),
  ]
  for (const job of mapJobs) {
    if (aborted()) return report
    try {
      if (await copyChannel(job.from(), job.to, remap)) report.maps++
    } catch (err) {
      report.errors.push({ path: job.label, message: message(err) })
    }
    progress.done++
    emit({ current: job.label })
  }

  // ── Fin : tout doit etre parti ────────────────────────────────────────────
  emit({ phase: 'finishing' })
  try {
    await target.flush()
  } catch (err) {
    if (err instanceof VaultGoneError) throw err
    report.errors.push({ path: '(repertoire)', message: message(err) })
  }
  emit({ phase: 'done', current: undefined })
  return report
}

// ── Plan ─────────────────────────────────────────────────────────────────────

async function planDocuments(
  docs: readonly IDocumentMeta[],
  target: IVaultSyncSession,
  kindOf: (path: string) => EntryKind,
  report: VaultTransferReport,
): Promise<Plan[]> {
  const byPath = new Map(target.directory.getAll().map(d => [d.path, d]))
  const plans: Plan[] = []
  const fresh: Plan[] = []
  for (const doc of docs) {
    const there = target.directory.getById(doc.id)
    const plan: Plan = {
      source: doc, targetId: doc.id, kind: kindOf(doc.path),
      // Meme document deja present : son chemin dans la cible reste le sien.
      targetPath: there ? there.path : doc.path,
      existing: !!there,
    }
    plans.push(plan)
    if (!there) fresh.push(plan)
  }

  // Inscription des nouveaux documents ; les identifiants refuses changent.
  const rejected = await registerFinding(target, fresh.map(p => p.targetId))
  const renewed: Plan[] = []
  for (const plan of fresh) {
    if (!rejected.has(plan.targetId)) continue
    const samePath = byPath.get(plan.source.path)
    if (samePath && kindOf(samePath.path) === plan.kind && !plans.some(p => p.existing && p.targetId === samePath.id)) {
      // Reprise d'une copie deja faite sous un autre identifiant.
      plan.targetId = samePath.id
      plan.existing = true
    } else {
      plan.targetId = crypto.randomUUID()
      renewed.push(plan)
    }
    report.renamedIds[plan.source.id] = plan.targetId
  }
  if (renewed.length > 0) {
    const stillRejected = await registerFinding(target, renewed.map(p => p.targetId))
    if (stillRejected.size > 0) {
      // Un identifiant neuf refuse : ce n'est pas une collision, c'est un refus.
      for (const plan of renewed.filter(p => stillRejected.has(p.targetId))) {
        report.errors.push({ path: plan.source.path, message: 'inscription du document refusee par la cible' })
      }
    }
    const refused = new Set(renewed.filter(p => stillRejected.has(p.targetId)))
    for (let i = plans.length - 1; i >= 0; i--) if (refused.has(plans[i])) plans.splice(i, 1)
  }

  // Chemins : un nouveau document ne prend pas la place d'un autre.
  const taken = new Set(target.directory.getAll().map(d => d.path))
  for (const plan of plans) if (plan.existing) taken.add(plan.targetPath)
  for (const plan of plans) {
    if (plan.existing) continue
    if (taken.has(plan.targetPath)) {
      plan.targetPath = uniquePath(plan.targetPath, p => taken.has(p))
      report.renamedPaths[plan.source.path] = plan.targetPath
    }
    taken.add(plan.targetPath)
  }
  return plans
}

/**
 * Inscrit les identifiants et rend ceux que la cible refuse. Le port ne dit
 * pas lequel est refuse : on coupe le lot en deux jusqu'a les trouver. Un
 * identifiant seul refuse est essaye une fois sous un identifiant neuf par
 * l'appelant : s'il passe, c'etait une collision.
 */
async function registerFinding(target: IVaultSyncSession, ids: string[]): Promise<Set<string>> {
  const rejected = new Set<string>()
  const visit = async (batch: string[]): Promise<void> => {
    if (batch.length === 0) return
    try {
      await target.registerDocuments(batch)
    } catch (err) {
      if (err instanceof VaultGoneError) throw err
      if (batch.length === 1) { rejected.add(batch[0]); return }
      const half = Math.ceil(batch.length / 2)
      await visit(batch.slice(0, half))
      await visit(batch.slice(half))
    }
  }
  for (let i = 0; i < ids.length; i += REGISTER_BATCH) await visit(ids.slice(i, i + REGISTER_BATCH))
  return rejected
}

function uniquePath(path: string, isTaken: (path: string) => boolean): string {
  const slash = path.lastIndexOf('/')
  const dot = path.lastIndexOf('.')
  const [base, ext] = dot > slash + 1 ? [path.slice(0, dot), path.slice(dot)] : [path, '']
  let n = 1
  while (isTaken(`${base} ${n}${ext}`)) n++
  return `${base} ${n}${ext}`
}

// ── Contenu d'un document ────────────────────────────────────────────────────

/** Copie le contenu. Rend false si la cible l'avait deja a l'identique. */
async function copyDocument(
  plan: Plan,
  source: IVaultSyncSession,
  target: IVaultSyncSession,
  report: VaultTransferReport,
): Promise<boolean> {
  const { source: doc, targetId } = plan
  if (plan.kind === 'crdt') {
    const state = await source.readDocumentState(doc.id)
    report.bytes += state.length
    if (isEmptyState(state)) return !plan.existing
    await target.mergeDocumentState(targetId, state)
    return true
  }
  if (plan.kind === 'snapshot') {
    const content = await source.readDocument(doc.id, 'snapshot')
    report.bytes += new TextEncoder().encode(content).length
    if (plan.existing && (await target.readDocument(targetId, 'snapshot')) === content) return false
    if (!plan.existing && content === '') return true
    const snap = target.openSnapshot(targetId)
    try {
      await snap.load()
      await snap.write(content)
    } finally {
      target.closeSnapshot(targetId)
    }
    // Un profil peut taire un envoi perdu : on relit ce que la cible garde.
    if ((await target.readDocument(targetId, 'snapshot')) !== content) {
      throw new Error('le contenu ecrit ne se relit pas dans la cible')
    }
    return true
  }
  // Piece jointe : la cible qui l'a deja dans son repertoire a deja ses octets.
  if (plan.existing) return false
  const file = await readFileBytes(source, doc)
  report.bytes += file.bytes.length
  // Un fichier nomme : le serveur controle l'extension par le nom.
  const name = plan.targetPath.slice(plan.targetPath.lastIndexOf('/') + 1)
  await target.files.upload(targetId, new File([file.bytes as BlobPart], name, { type: file.type }))
  return true
}

/** Un etat CRDT vide (jamais ecrit) : rien a fusionner. */
function isEmptyState(state: Uint8Array): boolean {
  return state.length === 0 || (state.length === 2 && state[0] === 0 && state[1] === 0)
}

/** Octets d'une piece jointe : sous son identifiant, sinon sous son ancien nom de stockage. */
async function readFileBytes(session: IVaultSyncSession, doc: IDocumentMeta): Promise<{ bytes: Uint8Array; type: string }> {
  try {
    return await session.files.readBytes(doc.id)
  } catch (err) {
    const legacy = doc.path.startsWith(ATTACHMENTS_DIR) ? doc.path.slice(ATTACHMENTS_DIR.length) : ''
    if (!legacy || legacy.includes('/')) throw err
    return session.files.readBytes(legacy)
  }
}

/** Annonce le rangement des pieces jointes copiees (partage d'une note). Sans effet sur un profil qui n'en a pas besoin. */
async function placeAttachments(plans: Plan[], target: IVaultSyncSession): Promise<void> {
  const place = target.files.place
  if (!place) return
  const all = target.directory.getAll()
  const paths = all.map(d => d.path)
  for (const plan of plans) {
    if (plan.kind !== 'file' || plan.existing || !target.directory.getById(plan.targetId)) continue
    const folder = plan.targetPath.slice(0, plan.targetPath.lastIndexOf('/') + 1)
    const notePath = folder ? folderNoteOf(folder, paths) : undefined
    const noteId = notePath ? all.find(d => d.path === notePath)?.id ?? null : null
    const name = plan.targetPath.slice(plan.targetPath.lastIndexOf('/') + 1)
    await place.call(target.files, plan.targetId, { noteId, name }).catch(() => { /* le partage seul ne la verra pas */ })
  }
}

// ── Cartes partagees ─────────────────────────────────────────────────────────

/** Copie les entrees d'une carte. Rend false si la source est vide (rien a copier). */
async function copyChannel(
  from: IIndexChannel,
  openTarget: () => IIndexChannel,
  remap: ReadonlyMap<string, string>,
): Promise<boolean> {
  await from.loaded
  const entries = from.getAll()
  if (entries.length === 0) return false
  const to = openTarget()
  await to.loaded
  const current = new Map(to.getAll().map(e => [e.id, JSON.stringify(e.value)]))
  for (const { id, value } of entries) {
    const key = remap.get(id) ?? id
    const moved = remapDocId(value, remap)
    if (current.get(key) !== JSON.stringify(moved)) to.set(key, moved)
  }
  return true
}

/** Une entree qui designe un document (`docId`, comme la revision) suit son nouvel identifiant. */
function remapDocId(value: unknown, remap: ReadonlyMap<string, string>): unknown {
  if (remap.size === 0 || !value || typeof value !== 'object' || Array.isArray(value)) return value
  const docId = (value as { docId?: unknown }).docId
  if (typeof docId !== 'string' || !remap.has(docId)) return value
  return { ...(value as object), docId: remap.get(docId) }
}
