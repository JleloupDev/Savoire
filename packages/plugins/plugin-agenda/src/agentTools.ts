// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Outils d'agent de l'agenda (ADR-033) : la note du jour d'une date (lire),
// y ajouter du texte (la creer d'abord, depuis le modele, si besoin).
import { changeNoteText, renderTemplate, type PluginAPI, type PluginTool } from '@savoire/plugin-api'
import { dailyNotePath, dailyTemplatePath, dateOfKey, dayKey } from './daily'

/** `2026-11-18`, « aujourd'hui », « demain », « hier ». */
export function dayOf(input: unknown, now = new Date()): string {
  const s = typeof input === 'string' ? input.trim().toLowerCase() : ''
  if (!s || s === "aujourd'hui" || s === 'aujourd’hui' || s === 'today') return dayKey(now)
  const shift = s === 'demain' || s === 'tomorrow' ? 1 : s === 'hier' || s === 'yesterday' ? -1 : null
  if (shift !== null) return dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + shift))
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  throw new Error('Date attendue : AAAA-MM-JJ, aujourd’hui, demain ou hier.')
}

export function agendaAgentTools(api: PluginAPI, files: () => Promise<string[]>): PluginTool[] {
  const date = { type: 'string' as const, description: 'AAAA-MM-JJ, « aujourd’hui », « demain » ou « hier ».' }
  return [
    {
      spec: {
        name: 'daily_note', title: 'Note du jour', action: 'read',
        description: 'La note du jour d’une date (Journal/AAAA-MM-JJ.md) : son chemin et son texte, ou qu’elle n’existe pas encore.',
        inputSchema: { type: 'object', properties: { date }, additionalProperties: false },
      },
      async run(args) {
        const key = dayOf(args.date)
        const all = await files()
        const path = dailyNotePath(key, all)
        if (!all.includes(path)) return { text: `Pas encore de note pour le ${key} (elle serait ${path}).` }
        const id = api.vault.resolveDocumentId(path)
        return { text: `# ${path}\n\n${await api.vault.readDocumentByPath(path)}`, ...(id ? { sources: [{ docId: id, path }] } : {}) }
      },
    },
    {
      spec: {
        name: 'append_to_daily', title: 'Écrire dans la note du jour', action: 'create',
        description: 'Ajoute du texte à la fin de la note du jour d’une date ; la crée d’abord (depuis le modèle « Note du jour ») si besoin.',
        inputSchema: { type: 'object', properties: { date, text: { type: 'string', description: 'Texte Markdown à ajouter.' } }, required: ['text'], additionalProperties: false },
      },
      async run(args, ctx) {
        const text = typeof args.text === 'string' ? args.text.trim() : ''
        if (!text) throw new Error('Le texte est vide.')
        const key = dayOf(args.date)
        const all = await files()
        const path = dailyNotePath(key, all)
        if (!all.includes(path)) {
          if (typeof api.vault.createFile !== 'function') throw new Error('Ce vault ne permet pas de créer de note.')
          const template = dailyTemplatePath(all)
          const base = template ? renderTemplate(await api.vault.readDocumentByPath(template), { title: key, date: dateOfKey(key) }) : ''
          await api.vault.createFile(path)
          const id = api.vault.resolveDocumentId(path)
          if (base && id && typeof api.vault.editText === 'function') await api.vault.editText(id, current => current || base)
        }
        const id = api.vault.resolveDocumentId(path)
        if (!id) throw new Error('La note du jour n’a pas pu être créée.')
        const r = await changeNoteText(api, ctx, id, md => {
          const sep = md === '' || md.endsWith('\n\n') ? '' : md.endsWith('\n') ? '\n' : '\n\n'
          return `${md}${sep}${text}\n`
        }, `ajout à la note du ${key}`)
        return { text: r === 'proposed' ? `Ajout proposé dans ${path} (Révision).` : `Ajouté à ${path}.`, sources: [{ docId: id, path }] }
      },
    },
  ]
}
