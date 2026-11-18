// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Outils d'agent des modeles (ADR-033) : lister les modeles, creer une note
// a partir d'un modele (variables {{title}}, {{date}}... remplacees).
import { noteTitleOf, renderTemplate, type PluginAPI, type PluginTool } from '@savoire/plugin-api'

export function templateAgentTools(api: PluginAPI, templates: () => Promise<string[]>): PluginTool[] {
  return [
    {
      spec: {
        name: 'list_templates', title: 'Modèles', action: 'read',
        description: 'Les modèles de notes du vault (dossier « Modèles »).',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      async run() {
        const list = await templates()
        return { text: list.length ? list.map(p => `- ${noteTitleOf(p)} (${p})`).join('\n') : 'Aucun modèle (dossier « Modèles » vide ou absent).' }
      },
    },
    {
      spec: {
        name: 'create_from_template', title: 'Créer depuis un modèle', action: 'create',
        description: 'Crée une note à partir d’un modèle. Le titre de la note remplace {{title}}.',
        inputSchema: {
          type: 'object',
          properties: { template: { type: 'string', description: 'Nom ou chemin du modèle.' }, path: { type: 'string', description: 'Chemin de la nouvelle note.' } },
          required: ['template', 'path'], additionalProperties: false,
        },
      },
      async run(args) {
        const wanted = typeof args.template === 'string' ? args.template.trim().toLowerCase() : ''
        const list = await templates()
        const tpl = list.find(p => p.toLowerCase() === wanted || noteTitleOf(p).toLowerCase() === wanted)
        if (!tpl) throw new Error(`Modèle introuvable : ${String(args.template)}. Voir list_templates.`)
        const raw = typeof args.path === 'string' ? args.path.trim().replace(/^\/+/, '') : ''
        if (!raw) throw new Error('Donnez le chemin de la note.')
        const path = /\.md$/i.test(raw) ? raw : `${raw}.md`
        if (api.vault.resolveDocumentId(path)) throw new Error(`Une note existe déjà : ${path}.`)
        if (typeof api.vault.createFile !== 'function' || typeof api.vault.editText !== 'function') throw new Error('Ce vault ne permet pas de créer de note.')
        const text = renderTemplate(await api.vault.readDocumentByPath(tpl), { title: noteTitleOf(path) })
        const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
        if (folder) await api.vault.createFolder?.(folder)
        await api.vault.createFile(path)
        const id = api.vault.resolveDocumentId(path)
        if (!id) throw new Error('La note n’a pas pu être créée.')
        if (text) await api.vault.editText(id, current => current || text)
        return { text: `Note créée depuis « ${noteTitleOf(tpl)} » : ${path}.`, sources: [{ docId: id, path }] }
      },
    },
  ]
}
