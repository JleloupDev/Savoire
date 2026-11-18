// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Outils d'agent des tags (ADR-033) : ajouter un tag a une note, renommer un
// tag dans tout le vault (sous-tags compris). Fait ou propose (une
// proposition de texte par note) selon le mode decide par l'application.
import { changeNoteText, noteRef, type PluginAPI, type PluginTool } from '@savoire/plugin-api'

const TAG_CHARS = /^[\p{L}\p{N}_\-/]+$/u

function cleanTag(v: unknown): string {
  const t = typeof v === 'string' ? v.trim().replace(/^#/, '') : ''
  if (!t || !TAG_CHARS.test(t)) throw new Error(`Tag invalide : ${String(v)}.`)
  return t
}

/** Remplace #from (et #from/sous-tag) par #to, hors blocs de code. */
export function renameTagIn(markdown: string, from: string, to: string): string {
  const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(^|[\\s(\\[])#${esc}(?=$|[\\s/.,;:!?)\\]])`, 'giu')
  let fence = false
  return markdown.split('\n').map(line => {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return line }
    return fence ? line : line.replace(re, `$1#${to}`)
  }).join('\n')
}

export function hashtagAgentTools(api: PluginAPI): PluginTool[] {
  return [
    {
      spec: {
        name: 'add_tag', title: 'Ajouter un tag', action: 'edit',
        description: 'Ajoute un tag (#tag) à une note, sur une ligne à la fin.',
        inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Note.' }, tag: { type: 'string', description: 'Le tag, sans #.' } }, required: ['path', 'tag'], additionalProperties: false },
      },
      async run(args, ctx) {
        const note = noteRef(api, args.path)
        const tag = cleanTag(args.tag)
        const r = await changeNoteText(api, ctx, note.id, md => {
          if (new RegExp(`(^|\\s)#${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'iu').test(md)) return md
          const sep = md === '' || md.endsWith('\n') ? '' : '\n'
          return `${md}${sep}#${tag}\n`
        }, `tag #${tag}`)
        if (r === 'unchanged') return { text: `${note.path} porte déjà #${tag}.` }
        return { text: r === 'proposed' ? `Tag proposé dans ${note.path} (Révision).` : `#${tag} ajouté à ${note.path}.`, sources: [{ docId: note.id, path: note.path }] }
      },
    },
    {
      spec: {
        name: 'rename_tag', title: 'Renommer un tag', action: 'edit',
        description: 'Renomme un tag dans toutes les notes du vault (ses sous-tags suivent : #projet/a devient #nouveau/a).',
        inputSchema: { type: 'object', properties: { from: { type: 'string', description: 'Tag actuel, sans #.' }, to: { type: 'string', description: 'Nouveau nom, sans #.' } }, required: ['from', 'to'], additionalProperties: false },
      },
      async run(args, ctx) {
        const from = cleanTag(args.from)
        const to = cleanTag(args.to)
        if (from.toLowerCase() === to.toLowerCase()) return { text: 'Rien à changer.' }
        const idx = api.indexer
        if (!idx?.available()) throw new Error('Index indisponible : réessayez plus tard.')
        const { items } = await idx.tags.notes({ tag: from, limit: 5000 })
        let done = 0
        let proposed = 0
        for (const n of items) {
          try {
            const r = await changeNoteText(api, ctx, n.id, md => renameTagIn(md, from, to), `#${from} → #${to}`)
            if (r === 'done') done++
            if (r === 'proposed') proposed++
          } catch { /* note refusee (droits) : on continue */ }
        }
        return { text: proposed ? `${proposed} note(s) : renommage proposé dans la Révision.` : `#${from} → #${to} dans ${done} note(s).` }
      },
    },
  ]
}
