// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Outils d'agent de l'historique (ADR-033) : lister les versions d'une note,
// voir ce qui a change, restaurer une version. Restaurer modifie la note
// (action « edit ») : en mode proposition, c'est une proposition de texte.
import { changeNoteText, noteRef, type ISharedMap, type PluginAPI, type PluginTool } from '@savoire/plugin-api'
import { authorLabel, diffLines, diffStats, listVersions } from './history'

export interface HistoryAccess {
  openMap(docId: string): ISharedMap | null
  /** La derniere frappe devient une version (avant de comparer ou restaurer). */
  flush(docId: string): void
}

export function historyAgentTools(api: PluginAPI, h: HistoryAccess): PluginTool[] {
  const versionsOf = (docId: string) => {
    h.flush(docId)
    const map = h.openMap(docId)
    if (!map) throw new Error('Historique indisponible.')
    return listVersions(map)
  }
  const pick = (docId: string, ref: unknown) => {
    const list = versionsOf(docId)
    const v = list.find(x => x.id === ref || x.at === ref) ?? (typeof ref === 'number' ? list[ref] : undefined)
    if (!v) throw new Error('Version introuvable : voir list_versions.')
    return v
  }
  const path = { type: 'string' as const, description: 'Note.' }
  const version = { type: 'string' as const, description: 'Id de la version (rendu par list_versions).' }
  return [
    {
      spec: {
        name: 'list_versions', title: 'Versions d’une note', action: 'read',
        description: 'Les versions d’une note (une toutes les 5 minutes d’écriture), avec leur date et leur auteur, de la plus récente à la plus ancienne.',
        inputSchema: { type: 'object', properties: { path }, required: ['path'], additionalProperties: false },
      },
      async run(args) {
        const note = noteRef(api, args.path)
        const list = versionsOf(note.id).slice(0, 50)
        if (!list.length) return { text: `Aucune version pour ${note.path}.` }
        const lines = list.map((v, i) => {
          const prev = list[i + 1]
          const s = prev ? diffStats(prev.text, v.text) : null
          return `- ${v.id} · ${v.at} · ${(v.author ? authorLabel(v.author) : 'inconnu')}${s ? ` · +${s.added} −${s.removed}` : ''}`
        })
        return { text: `Versions de ${note.path} :\n${lines.join('\n')}`, sources: [{ docId: note.id, path: note.path }] }
      },
    },
    {
      spec: {
        name: 'diff_version', title: 'Comparer à une version', action: 'read',
        description: 'Ce qui a changé entre une version et le texte actuel de la note (lignes ajoutées « + », retirées « − »).',
        inputSchema: { type: 'object', properties: { path, version }, required: ['path', 'version'], additionalProperties: false },
      },
      async run(args) {
        const note = noteRef(api, args.path)
        const v = pick(note.id, args.version)
        const now = await api.vault.read(note.id)
        const changed = diffLines(v.text, now).filter(l => l.kind !== 'same')
        if (!changed.length) return { text: 'Aucune différence.' }
        return { text: changed.slice(0, 300).map(l => `${l.kind === 'add' ? '+' : '−'} ${l.text}`).join('\n'), sources: [{ docId: note.id, path: note.path }] }
      },
    },
    {
      spec: {
        name: 'restore_version', title: 'Restaurer une version', action: 'edit',
        description: 'Remet la note dans l’état d’une version. Le texte actuel reste dans l’historique.',
        inputSchema: { type: 'object', properties: { path, version }, required: ['path', 'version'], additionalProperties: false },
      },
      async run(args, ctx) {
        const note = noteRef(api, args.path)
        const v = pick(note.id, args.version)
        const r = await changeNoteText(api, ctx, note.id, () => v.text, `restaurer la version du ${v.at}`)
        if (r === 'unchanged') return { text: 'La note est déjà dans cet état.' }
        return { text: r === 'proposed' ? `Restauration proposée dans la Révision de ${note.path}.` : `${note.path} restaurée à la version du ${v.at}.`, sources: [{ docId: note.id, path: note.path }] }
      },
    },
  ]
}
