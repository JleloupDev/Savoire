// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Outils d'agent des listes de taches (ADR-033) : les taches « - [ ] » des
// notes. Lister (une note, ou tout le vault), ajouter, cocher. Une
// modification est faite ou proposee selon le mode decide par l'application.
import { changeNoteText, noteRef, type PluginAPI, type PluginTool } from '@savoire/plugin-api'

export interface Task { line: number; done: boolean; text: string; depth: number }

const TASK_RE = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/

/** Les taches d'un texte Markdown (hors blocs de code). */
export function parseTasks(markdown: string): Task[] {
  const out: Task[] = []
  let fence = false
  markdown.split('\n').forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence
    if (fence) return
    const m = TASK_RE.exec(l)
    if (m) out.push({ line: i, done: m[2] !== ' ', text: m[3]!.trim(), depth: Math.floor(m[1]!.replace(/\t/g, '  ').length / 2) })
  })
  return out
}

/** Ajoute une tache : sous la derniere tache de la note, sinon a la fin. */
export function addTask(markdown: string, text: string): string {
  const line = `- [ ] ${text.replace(/\n+/g, ' ').trim()}`
  const tasks = parseTasks(markdown)
  const lines = markdown.split('\n')
  if (tasks.length) {
    lines.splice(tasks.at(-1)!.line + 1, 0, line)
    return lines.join('\n')
  }
  const sep = markdown === '' || markdown.endsWith('\n\n') ? '' : markdown.endsWith('\n') ? '\n' : '\n\n'
  return `${markdown}${sep}${line}\n`
}

/** Coche ou decoche la tache dont le texte contient `match` (la premiere). Null : introuvable ou ambigue. */
export function setTaskDone(markdown: string, match: string, done: boolean): string | null {
  const wanted = match.trim().toLowerCase()
  const hits = parseTasks(markdown).filter(t => t.text.toLowerCase() === wanted)
  const found = hits.length ? hits : parseTasks(markdown).filter(t => t.text.toLowerCase().includes(wanted))
  if (found.length !== 1) return null
  const lines = markdown.split('\n')
  lines[found[0]!.line] = lines[found[0]!.line]!.replace(/\[([ xX])\]/, done ? '[x]' : '[ ]')
  return lines.join('\n')
}

async function allNotes(api: PluginAPI, max: number): Promise<string[]> {
  const out: string[] = []
  const queue = ['']
  while (queue.length && out.length < max) {
    const dir = queue.shift()!
    for (const e of await api.vault.list(dir || undefined)) {
      if (e.endsWith('/')) { if (e !== dir && !e.startsWith('.trash/')) queue.push(e) }
      else if (e.toLowerCase().endsWith('.md')) out.push(e)
    }
  }
  return out.slice(0, max)
}

const MAX_NOTES = 400

export function taskAgentTools(api: PluginAPI): PluginTool[] {
  return [
    {
      spec: {
        name: 'list_tasks', title: 'Lister les tâches', action: 'read', runtimes: ['app', 'server'],
        description: 'Les tâches « - [ ] » d’une note, ou de tout le vault sans note. open_only : seulement celles à faire.',
        inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Note (facultatif).' }, open_only: { type: 'boolean', description: 'Seulement les tâches à faire (oui par défaut).' } }, additionalProperties: false },
      },
      async run(args) {
        const openOnly = args.open_only !== false
        const paths = args.path ? [noteRef(api, args.path).path] : await allNotes(api, MAX_NOTES)
        const lines: string[] = []
        const sources: { docId: string; path: string }[] = []
        for (const path of paths) {
          let text: string
          try { text = await api.vault.readDocumentByPath(path) } catch { continue }
          const tasks = parseTasks(text).filter(t => !openOnly || !t.done)
          if (!tasks.length) continue
          const id = api.vault.resolveDocumentId(path)
          if (id) sources.push({ docId: id, path })
          lines.push(`${path} :`, ...tasks.map(t => `  ${'  '.repeat(t.depth)}- [${t.done ? 'x' : ' '}] ${t.text}`))
        }
        return { text: lines.length ? lines.join('\n') : 'Aucune tâche.', sources }
      },
    },
    {
      spec: {
        name: 'add_task', title: 'Ajouter une tâche', action: 'edit', runtimes: ['app', 'server'],
        description: 'Ajoute une tâche « - [ ] » à une note (sous ses tâches, sinon à la fin).',
        inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Note.' }, text: { type: 'string', description: 'La tâche.' } }, required: ['path', 'text'], additionalProperties: false },
      },
      async run(args, ctx) {
        const note = noteRef(api, args.path)
        const text = typeof args.text === 'string' ? args.text.trim() : ''
        if (!text) throw new Error('La tâche est vide.')
        const r = await changeNoteText(api, ctx, note.id, md => addTask(md, text), `tâche « ${text} »`)
        return { text: r === 'proposed' ? `Tâche proposée dans ${note.path} (Révision).` : `Tâche ajoutée à ${note.path}.`, sources: [{ docId: note.id, path: note.path }] }
      },
    },
    {
      spec: {
        name: 'check_task', title: 'Cocher une tâche', action: 'edit', runtimes: ['app', 'server'],
        description: 'Coche (ou décoche) une tâche d’une note, désignée par son texte.',
        inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Note.' }, task: { type: 'string', description: 'Texte de la tâche.' }, done: { type: 'boolean', description: 'Faite (oui par défaut).' } }, required: ['path', 'task'], additionalProperties: false },
      },
      async run(args, ctx) {
        const note = noteRef(api, args.path)
        const match = typeof args.task === 'string' ? args.task : ''
        const done = args.done !== false
        let missing = false
        const r = await changeNoteText(api, ctx, note.id, md => {
          const next = setTaskDone(md, match, done)
          if (next === null) { missing = true; return md }
          return next
        }, `${done ? 'cocher' : 'décocher'} « ${match} »`)
        if (missing) throw new Error('Tâche introuvable ou ambiguë : donnez son texte exact (list_tasks).')
        if (r === 'unchanged') return { text: 'La tâche était déjà dans cet état.' }
        return { text: r === 'proposed' ? `Proposé dans la Révision de ${note.path}.` : `Tâche ${done ? 'cochée' : 'décochée'} dans ${note.path}.`, sources: [{ docId: note.id, path: note.path }] }
      },
    },
  ]
}
