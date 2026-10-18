// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Format d'un vault sur disque : ce que contient le dossier cache `.savoire/`
// et comment on le lit. Voir docs/Architecture/desktop-vault-format.md.
//
//   .savoire/vault.json        id du vault, nom, version du format
//   .savoire/documents.json    id stable de chaque fichier visible (+ taille, date)
//   .savoire/crdt/<id>/        etat Yjs d'un document CRDT : mises a jour, etat compacte
//   .savoire/maps/<nom>/       cartes partagees (index, reglages, cartes) : meme forme
//   .savoire/snapshots/<id>.json  qui a ecrit en dernier un document snapshot
//   .savoire/detached/<id>     contenu d'un document qui n'a pas (encore) de chemin
//
// Rien ici ne touche aux notes : ouvrir un dossier Obsidian ne cree que `.savoire/`.
import type { IVaultFileSystem } from '@savoire/platform'

/** Version du format de `.savoire/`. Un format plus recent que celui-ci est refuse. */
export const VAULT_FORMAT_VERSION = 1

export const SAVOIRE_DIR = '.savoire'
export const VAULT_META_PATH = `${SAVOIRE_DIR}/vault.json`
export const DOCUMENTS_PATH = `${SAVOIRE_DIR}/documents.json`
export const CRDT_DIR = `${SAVOIRE_DIR}/crdt`
export const MAPS_DIR = `${SAVOIRE_DIR}/maps`
export const SNAPSHOTS_DIR = `${SAVOIRE_DIR}/snapshots`
export const DETACHED_DIR = `${SAVOIRE_DIR}/detached`
/** Corbeille, a la racine, comme Obsidian (voir @savoire/platform trash.ts). */
export const TRASH_FOLDER = '.trash'

/** `.savoire/vault.json`. */
export interface VaultFolderMeta {
  format: number
  id: string
  name: string
  createdAt: string
}

/** Une entree de `.savoire/documents.json`. */
export interface DocumentIdEntry {
  path: string
  /** Taille et date vues en dernier : servent a reconnaitre un renommage externe. */
  size?: number
  mtimeMs?: number
  /** Empreinte du contenu, quand on l'a lu (textes) : meme usage. */
  hash?: string
}

export interface DocumentsFile {
  format: number
  documents: Record<string, DocumentIdEntry>
  /**
   * Dossiers crees expres dans l'application (« A/B/ »). Un dossier vide par
   * le depart de son dernier fichier (deplace, mis a la corbeille) quitte le
   * disque, sauf s'il est dans cette liste.
   */
  folders?: string[]
}

/** Le format de ce dossier est plus recent que ce que sait lire cette version. */
export class UnsupportedVaultFormatError extends Error {
  constructor(readonly found: number) {
    super(`Ce vault utilise le format ${found}, plus recent que celui de cette version (${VAULT_FORMAT_VERSION}). Mettez Savoire a jour.`)
    this.name = 'UnsupportedVaultFormatError'
  }
}

/** Lit `.savoire/vault.json`. null : le dossier n'est pas (encore) un vault Savoire. */
export async function readVaultFolderMeta(fs: IVaultFileSystem): Promise<VaultFolderMeta | null> {
  if (!(await fs.exists(VAULT_META_PATH))) return null
  const raw = JSON.parse(await fs.readText(VAULT_META_PATH)) as Partial<VaultFolderMeta>
  if (typeof raw.id !== 'string' || typeof raw.format !== 'number') {
    throw new Error(`${VAULT_META_PATH} est illisible`)
  }
  return {
    format: raw.format,
    id: raw.id,
    name: typeof raw.name === 'string' ? raw.name : '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
  }
}

/**
 * Fait d'un dossier un vault Savoire : cree `.savoire/vault.json`. Le dossier
 * peut etre vide ou contenir deja des notes (vault Obsidian) : rien d'autre
 * n'est ecrit, aucune note n'est touchee. Sans effet si le dossier est deja
 * un vault (rend alors ses informations).
 */
export async function initializeVaultFolder(
  fs: IVaultFileSystem,
  init: { id?: string; name?: string } = {},
): Promise<VaultFolderMeta> {
  const existing = await readVaultFolderMeta(fs)
  if (existing) return existing
  const meta: VaultFolderMeta = {
    format: VAULT_FORMAT_VERSION,
    id: init.id ?? crypto.randomUUID(),
    name: init.name ?? fs.rootLabel.split(/[\\/]/).filter(Boolean).at(-1) ?? 'Vault',
    createdAt: new Date().toISOString(),
  }
  await fs.writeText(VAULT_META_PATH, `${JSON.stringify(meta, null, 2)}\n`)
  return meta
}

// ── Chemins visibles ─────────────────────────────────────────────────────────

/**
 * Un chemin du dossier fait-il partie du vault ? Non pour tout ce qui passe
 * par un dossier ou un fichier cache (`.savoire/`, `.obsidian/`, `.git/`,
 * `.DS_Store`, fichiers temporaires « .x.tmp »), sauf la corbeille `.trash/`
 * a la racine, qui est un dossier du vault comme dans Obsidian.
 */
export function isVaultPath(path: string): boolean {
  if (!path) return false
  const parts = path.split('/')
  return parts.every((part, i) => !part.startsWith('.') || (i === 0 && part === TRASH_FOLDER && parts.length > 1))
}

/** Dossier du vault (hors corbeille), tel que le repertoire les nomme : « A/B/ ». */
export function isVaultFolder(path: string): boolean {
  return isVaultPath(path) && path !== TRASH_FOLDER && !path.startsWith(`${TRASH_FOLDER}/`)
}

/** Nom de fichier sur pour un identifiant ou un nom de carte (tous systemes). */
export function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, c => `~${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** Inverse de safeName. */
export function unsafeName(name: string): string {
  return name.replace(/~([0-9a-f]{4})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
}

export function crdtDirOf(docId: string): string {
  return `${CRDT_DIR}/${safeName(docId)}`
}

export function mapDirOf(name: string): string {
  return `${MAPS_DIR}/${safeName(name)}`
}

export function snapshotMetaOf(docId: string): string {
  return `${SNAPSHOTS_DIR}/${safeName(docId)}.json`
}

export function detachedPathOf(docId: string): string {
  return `${DETACHED_DIR}/${safeName(docId)}`
}

// ── Empreintes ───────────────────────────────────────────────────────────────

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource))
}

function hex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/** Empreinte d'un contenu (SHA-256, hexadecimal tronque a 32 caracteres). */
export async function contentHash(content: string | Uint8Array): Promise<string> {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
  return hex(await sha256(bytes)).slice(0, 32)
}

/**
 * Identifiant d'un fichier decouvert sur le disque (pose par un autre outil,
 * ou vault Obsidian ouvert pour la premiere fois). Deterministe : deux
 * sessions qui decouvrent le meme fichier lui donnent le meme id. Forme d'un
 * UUID (version 8, « defini par l'application »).
 */
export async function discoveredDocumentId(vaultId: string, path: string): Promise<string> {
  const h = hex(await sha256(new TextEncoder().encode(`savoire-document:${vaultId}:${path}`)))
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/** Entier 32 bits non nul tire d'une graine : identifiant de client Yjs deterministe. */
export async function deterministicClientId(seed: string): Promise<number> {
  const bytes = await sha256(new TextEncoder().encode(seed))
  const n = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0
  return n === 0 ? 1 : n
}

// ── Types de fichiers ────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp', pdf: 'application/pdf',
  md: 'text/markdown', txt: 'text/plain', json: 'application/json', csv: 'text/csv',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm',
}

/** Type MIME d'apres l'extension. */
export function mimeTypeOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return (dot > 0 && MIME[name.slice(dot + 1).toLowerCase()]) || 'application/octet-stream'
}

/** Extensions des documents CRDT dont le contenu est un texte (projete dans le fichier visible). */
export const DEFAULT_TEXT_EXTENSIONS: ReadonlySet<string> = new Set(['md', 'markdown', 'txt', 'outline'])

export function hasExtension(path: string, extensions: ReadonlySet<string>): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 && extensions.has(name.slice(dot + 1).toLowerCase())
}
