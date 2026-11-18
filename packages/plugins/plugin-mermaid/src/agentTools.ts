// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Outil d'agent de Mermaid (ADR-033) : ajouter un schema (flux, sequence,
// planning...) a une note, en bloc ```mermaid. Fait ou propose selon le mode.
import { changeNoteText, noteRef, type PluginAPI, type PluginTool } from '@savoire/plugin-api'

export function mermaidAgentTools(api: PluginAPI): PluginTool[] {
  return [{
    spec: {
      name: 'insert_diagram', title: 'Ajouter un schéma', action: 'edit',
      description: 'Ajoute un schéma Mermaid à la fin d’une note (flowchart, sequenceDiagram, gantt, mindmap...). code : le code Mermaid seul, sans ```.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Note.' }, code: { type: 'string', description: 'Code Mermaid.' }, title: { type: 'string', description: 'Titre au-dessus du schéma (facultatif).' } },
        required: ['path', 'code'], additionalProperties: false,
      },
    },
    async run(args, ctx) {
      const note = noteRef(api, args.path)
      const code = typeof args.code === 'string' ? args.code.replace(/^```(?:mermaid)?\s*|\s*```\s*$/g, '').trim() : ''
      if (!code) throw new Error('Le schéma est vide.')
      const title = typeof args.title === 'string' && args.title.trim() ? `**${args.title.trim()}**\n\n` : ''
      const block = `${title}\`\`\`mermaid\n${code}\n\`\`\`\n`
      const r = await changeNoteText(api, ctx, note.id, md => {
        const sep = md === '' || md.endsWith('\n\n') ? '' : md.endsWith('\n') ? '\n' : '\n\n'
        return `${md}${sep}${block}`
      }, 'schéma Mermaid')
      return { text: r === 'proposed' ? `Schéma proposé dans ${note.path} (Révision).` : `Schéma ajouté à ${note.path}.`, sources: [{ docId: note.id, path: note.path }] }
    },
  }]
}
