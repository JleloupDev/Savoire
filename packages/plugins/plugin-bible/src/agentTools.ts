// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Outils d'agent de la Bible (ADR-033) : chercher et citer des versets dans
// les notes Bible installees (dossier « Bible/ »), inserer une reference
// (ses versets integres, comme la commande du plugin) dans une note. Le
// texte vient des notes du vault, jamais d'un site.
import { changeNoteText, noteRef, type PluginAPI, type PluginTool } from '@savoire/plugin-api'
import type { ReferenceParser, VerseTarget } from './parse'
import { embedOf, type LinkTarget } from './suggest'

export interface BibleToolState {
  /** Les references chargees ; null si aucune Bible n'est installee. */
  parser(): Promise<ReferenceParser | null>
  linkTarget: LinkTarget
}

const MAX_VERSES = 50
const NO_BIBLE = 'Aucune Bible installée : la personne la choisit dans le panneau « Bible ».'

const label = (t: VerseTarget): string => `${t.info.name}:${t.verse}`
const verseLine = (t: VerseTarget): string => `${label(t)} ${t.info.verses.get(t.verse) ?? ''}`.trim()

export function bibleAgentTools(api: PluginAPI, state: BibleToolState): PluginTool[] {
  const reference = { type: 'string' as const, description: 'Référence : « Jean 3:16 », « Gen 1:1-3 », « Ps 23:1-6 ».' }
  return [
    {
      spec: {
        name: 'bible_find', title: 'Chercher dans la Bible', action: 'read',
        description: 'Le texte d’une référence (« Jean 3:16 », « Gen 1:1-3 »), ou les versets qui contiennent un mot (accents et casse ignorés). Lit la Bible installée dans le vault.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string', description: 'Une référence, ou un mot à chercher.' }, limit: { type: 'integer', description: 'Versets au plus (20 par défaut).' } },
          required: ['query'], additionalProperties: false,
        },
      },
      async run(args) {
        const parser = await state.parser()
        if (!parser) return { text: NO_BIBLE, isError: true }
        const query = typeof args.query === 'string' ? args.query.trim() : ''
        if (!query) throw new Error('Donnez une référence ou un mot.')
        const limit = Math.min(MAX_VERSES, Math.max(1, Number(args.limit) || 20))
        const parsed = parser.parse(query)
        const targets = parsed ? parsed.targets.slice(0, MAX_VERSES) : parser.search(query, limit)
        if (!targets.length) return { text: `Rien pour « ${query} ».` }
        const docs = new Map(targets.map(t => [t.info.path, api.vault.resolveDocumentId(t.info.path)]))
        return {
          text: `${parsed ? parsed.label : `Versets avec « ${query} »`} :\n${targets.map(verseLine).join('\n')}`,
          sources: [...docs].filter((e): e is [string, string] => !!e[1]).map(([path, docId]) => ({ docId, path })),
        }
      },
    },
    {
      spec: {
        name: 'bible_insert', title: 'Insérer une référence biblique', action: 'edit',
        description: 'Insère dans une note les versets d’une référence (intégrés depuis la Bible du vault : ![[Jean 3#^16]]). Sous la ligne qui contient `after`, sinon à la fin.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Note.' }, reference, after: { type: 'string', description: 'Texte de la ligne sous laquelle insérer (facultatif).' } },
          required: ['path', 'reference'], additionalProperties: false,
        },
      },
      async run(args, ctx) {
        const parser = await state.parser()
        if (!parser) return { text: NO_BIBLE, isError: true }
        const note = noteRef(api, args.path)
        const ref = typeof args.reference === 'string' ? args.reference.trim() : ''
        const parsed = ref ? parser.parse(ref) : null
        if (!parsed) throw new Error(`Référence inconnue : ${ref || '(vide)'}.`)
        const embeds = parsed.targets.slice(0, MAX_VERSES).map(t => embedOf(t, state.linkTarget)).join('\n')
        const after = typeof args.after === 'string' ? args.after.trim() : ''
        let missing = false
        const r = await changeNoteText(api, ctx, note.id, md => {
          if (after) {
            const i = md.indexOf(after)
            if (i < 0) { missing = true; return md }
            const end = md.indexOf('\n', i + after.length)
            const at = end < 0 ? md.length : end
            return `${md.slice(0, at)}\n${embeds}${md.slice(at)}`
          }
          const sep = md === '' || md.endsWith('\n') ? '' : '\n'
          return `${md}${sep}${embeds}\n`
        }, `référence ${parsed.label}`)
        if (missing) throw new Error(`Texte introuvable dans la note : « ${after} ».`)
        return {
          text: r === 'proposed' ? `${parsed.label} proposé dans ${note.path} (Révision).` : `${parsed.label} inséré dans ${note.path} (${parsed.targets.length} verset(s)).`,
          sources: [{ docId: note.id, path: note.path }],
        }
      },
    },
  ]
}
