// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le titre de la note, en haut. A la difference d'Obsidian (le titre y est
// le nom du fichier), le vrai titre est ici le H1 qui ouvre la note : c'est
// lui qu'on montre et qu'on modifie, et le fichier est renomme pour le
// suivre, quand on quitte la ligne du titre. Les liens vers la note suivent
// (VaultAPI.moveFiles). Une note sans H1 montre son nom de fichier en
// filigrane : un clic en fait le titre, a modifier.

import { StateEffect, StateField, Transaction, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import type { VaultAPI } from '@savoire/plugin-api'
import { frontmatterEnd } from './PropertiesPanel'

/** Ligne de titre : `# Texte`, ou `#` seul (titre vide). Pas `#tag`. */
const H1_RE = /^ {0,3}#(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/

export interface NoteTitle {
  /** Debut du corps de la note (apres les proprietes et les lignes vides). */
  bodyStart: number
  /** La ligne du H1 qui ouvre la note, s'il y en a un. */
  line: { from: number; to: number; text: string } | null
}

/** Le titre de la note : le H1, s'il est le premier bloc du corps. */
export function noteTitle(state: EditorState): NoteTitle {
  const doc = state.doc
  const fmEnd = frontmatterEnd(state)
  for (let n = fmEnd > 0 ? doc.lineAt(fmEnd).number : 1; n <= doc.lines; n++) {
    const line = doc.line(n)
    if (line.from < fmEnd || !line.text.trim()) continue
    const m = H1_RE.exec(line.text)
    return { bodyStart: line.from, line: m ? { from: line.from, to: line.to, text: (m[1] ?? '').trim() } : null }
  }
  return { bodyStart: doc.length, line: null }
}

/** Le texte du titre, sans la mise en forme Markdown. */
export function plainTitle(text: string): string {
  return text
    .replace(/!?\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/!?\[\[([^\]]*)\]\]/g, (_m, t: string) => t.split('/').pop() ?? t)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|==|\*|_|`)/g, '')
    .trim()
}

/** Nom de fichier tire d'un titre ('' : rien d'utilisable). */
export function fileNameForTitle(title: string): string {
  return plainTitle(title)
    .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .replace(/[. ]+$/, '')
}

const stemOf = (path: string) => {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

/**
 * Le chemin que prend la note `path` pour le titre `title`, dans le meme
 * dossier et avec la meme extension ; un nom pris recoit « 2 », « 3 »...
 * Null si rien ne change.
 */
export function pathForTitle(path: string, title: string, taken: (p: string) => boolean): string | null {
  const name = fileNameForTitle(title)
  if (!name || name === stemOf(path)) return null
  const dir = path.slice(0, path.lastIndexOf('/') + 1)
  const dot = path.lastIndexOf('.')
  const ext = dot > dir.length ? path.slice(dot) : ''
  for (let n = 1; n < 100; n++) {
    const candidate = `${dir}${n === 1 ? name : `${name} ${n}`}${ext}`
    if (candidate === path) return null
    if (!taken(candidate)) return candidate
  }
  return null
}

/**
 * Renomme la note pour son titre. Ses sous-pages (dossier frere du meme nom,
 * voir les notes de dossier de l'arborescence) la suivent, et les liens des
 * autres notes aussi. Rend le nouveau chemin, ou null si rien n'a change.
 */
export async function renameNoteForTitle(vault: VaultAPI, path: string, title: string): Promise<string | null> {
  if (!vault.renameFile && !vault.moveFiles) return null
  const to = pathForTitle(path, title, p => !!vault.resolveDocumentId(p))
  if (!to) return null
  const dir = path.slice(0, path.lastIndexOf('/') + 1)
  const oldFolder = `${dir}${stemOf(path)}/`
  const newFolder = `${dir}${stemOf(to)}/`
  const moves = [{ from: path, to }]
  const hasFolder = (await vault.list(dir)).includes(oldFolder)
  const emptyFolders: string[] = []
  if (hasFolder) {
    // Le dossier entier, a toute profondeur : ses documents changent de prefixe.
    const queue = [oldFolder]
    while (queue.length) {
      const folder = queue.shift()!
      const entries = await vault.list(folder)
      if (!entries.some(e => !e.endsWith('/'))) emptyFolders.push(folder)
      for (const entry of entries) {
        if (entry.endsWith('/')) queue.push(entry)
        else moves.push({ from: entry, to: newFolder + entry.slice(oldFolder.length) })
      }
    }
    if (moves.some(m => m !== moves[0] && vault.resolveDocumentId(m.to))) return null
    await vault.folderMoved?.(oldFolder, newFolder)
  }
  if (vault.moveFiles) await vault.moveFiles(moves)
  else for (const m of moves) {
    const id = vault.resolveDocumentId(m.from)
    if (id) await vault.renameFile!(id, m.to)
  }
  if (hasFolder) {
    for (const folder of emptyFolders) await vault.createFolder?.(newFolder + folder.slice(oldFolder.length))
    await vault.deleteFolder?.(oldFolder)
  }
  return to
}

// ── Dans l'editeur ──────────────────────────────────────────────────────────

export interface NoteTitleOptions {
  /** Chemin actuel de la note (il change avec un renommage). */
  path: () => string | null
  /** Le titre a change ici : renommer le fichier. */
  rename?: (title: string) => void
  /** Montrer le nom du fichier en filigrane quand la note n'a pas de titre (pas en mode source). */
  placeholder?: boolean
}

/** Le chemin a change (renommage) : le filigrane se redessine. */
export const notePathChanged = StateEffect.define<null>()

export class TitlePlaceholder extends WidgetType {
  constructor(readonly name: string, readonly canEdit: boolean) { super() }
  eq(other: TitlePlaceholder) { return other.name === this.name && other.canEdit === this.canEdit }
  toDOM(view: EditorView) {
    const wrap = document.createElement('div')
    wrap.className = 'plume-note-title-placeholder vault-rendered-block'
    wrap.dataset.testid = 'note-title-placeholder'
    const h1 = document.createElement('h1')
    h1.textContent = this.name
    wrap.appendChild(h1)
    if (this.canEdit) {
      wrap.title = 'Donner un titre à la note'
      wrap.addEventListener('mousedown', e => {
        if (e.button !== 0) return
        e.preventDefault()
        startTitle(view, this.name)
      })
    }
    return wrap
  }
  ignoreEvent() { return true }
}

/** Fait du nom de fichier le titre (H1), selectionne : on tape le nouveau. */
export function startTitle(view: EditorView, name: string): void {
  const { bodyStart, line } = noteTitle(view.state)
  if (line) return
  const rest = bodyStart < view.state.doc.length
  const insert = `# ${name}${rest ? '\n\n' : ''}`
  view.dispatch({
    changes: { from: bodyStart, insert },
    selection: { anchor: bodyStart + 2, head: bodyStart + 2 + name.length },
    scrollIntoView: true,
    userEvent: 'input.title',
  })
  view.focus()
}

function placeholder(state: EditorState, opts: NoteTitleOptions): DecorationSet {
  const { bodyStart, line } = noteTitle(state)
  const path = opts.path()
  if (line || !path) return Decoration.none
  const widget = new TitlePlaceholder(stemOf(path), !state.readOnly)
  return Decoration.set([Decoration.widget({ widget, block: true, side: -1 }).range(bodyStart)])
}

/** Titre en haut de la note : filigrane sans H1, renommage quand le H1 change. */
export function noteTitleExtension(opts: NoteTitleOptions): Extension {
  const field = StateField.define<DecorationSet>({
    create: state => placeholder(state, opts),
    update(deco, tr) {
      if (tr.docChanged || tr.effects.some(e => e.is(notePathChanged))) return placeholder(tr.state, opts)
      return deco
    },
    provide: f => EditorView.decorations.from(f),
  })

  const renamer = ViewPlugin.fromClass(class {
    /** Le titre a ete modifie ici, et pas encore reporte sur le fichier. */
    dirty = false
    constructor(readonly view: EditorView) {}
    update(u: ViewUpdate) {
      if (u.docChanged && u.transactions.some(tr => tr.annotation(Transaction.userEvent) !== undefined)) {
        const before = noteTitle(u.startState).line?.text
        const after = noteTitle(u.state).line?.text
        if (before !== after) this.dirty = true
      }
      if (this.dirty && (u.selectionSet || u.focusChanged || u.docChanged)) this.commitIfLeft()
    }
    /** On a quitte la ligne du titre (ou l'editeur) : le fichier suit. */
    commitIfLeft() {
      const { line } = noteTitle(this.view.state)
      const head = this.view.state.selection.main.head
      const onTitle = line && head >= line.from && head <= line.to
      if (onTitle && this.view.hasFocus) return
      this.commit()
    }
    commit() {
      if (!this.dirty) return
      this.dirty = false
      const text = noteTitle(this.view.state).line?.text
      if (text && !this.view.state.readOnly) opts.rename?.(text)
    }
    destroy() { this.commit() }
  })

  return [
    ...(opts.placeholder === false ? [] : [field]),
    renamer,
    EditorView.baseTheme({
      '.plume-note-title-placeholder': { cursor: 'text', opacity: '0.4' },
      '.plume-note-title-placeholder > h1': { margin: '0' },
    }),
  ]
}
