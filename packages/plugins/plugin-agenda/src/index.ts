// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Plugin core « Agenda » : un calendrier dans la barre de droite et une note
// par jour (`Journal/2026-11-07.md`), comme les notes quotidiennes
// d'Obsidian. Une note du jour neuve part du modele « Note du jour » du
// dossier des modeles s'il existe (variables : voir renderTemplate).
import type { PluginAPI, VaultPlugin } from '@savoire/plugin-api'
import { renderTemplate } from '@savoire/plugin-api'
import { AgendaWidget, type AgendaHost } from './AgendaWidget'
import { dailyNotePath, dailyTemplatePath, dateOfKey, dayKey } from './daily'

async function allFiles(api: PluginAPI): Promise<string[]> {
  const files: string[] = []
  const queue = ['']
  while (queue.length) {
    const dir = queue.shift()!
    for (const entry of await api.vault.list(dir || undefined)) {
      if (entry.endsWith('/')) { if (entry !== dir) queue.push(entry) }
      else files.push(entry)
    }
  }
  return files
}

/** Ouvre la note de ce jour ; la cree d'abord si besoin, depuis le modele. */
export async function openDailyNote(api: PluginAPI, key: string): Promise<string> {
  const files = await allFiles(api)
  const path = dailyNotePath(key, files)
  if (!files.includes(path)) {
    if (typeof api.vault.createFile !== 'function') throw new Error('Ce vault ne permet pas de créer de note.')
    const template = dailyTemplatePath(files)
    const text = template ? renderTemplate(await api.vault.readDocumentByPath(template), { title: key, date: dateOfKey(key) }) : ''
    await api.vault.createFile(path)
    const id = api.vault.resolveDocumentId(path)
    if (text && id && typeof api.vault.editText === 'function') await api.vault.editText(id, current => current || text)
    api.workspace?.notifyVaultChange?.()
  }
  await api.workspace.openFile(path)
  return path
}

export function createAgendaPlugin(options: { container?: 'left' | 'right'; ribbon?: boolean } = {}): VaultPlugin {
  return {
    manifest: {
      id: 'plugin-agenda',
      name: 'Agenda',
      version: '0.0.1',
      description: 'Un calendrier et une note par jour (Journal/AAAA-MM-JJ.md), avec le modèle « Note du jour »',
      scope: 'vault',
      permissions: ['ui:editor', 'vault:read', 'vault:write'],
      defaultActive: true,
    },

    async onload(api: PluginAPI) {
      const open = (key: string) => openDailyNote(api, key).then(() => {}, err => {
        api.workspace?.notify?.('danger', 'Note du jour', err instanceof Error ? err.message : String(err))
      })
      const host: AgendaHost = { files: () => allFiles(api), openDay: open }

      api.views.register({
        id: 'agenda',
        title: 'Agenda',
        icon: 'calendar',
        container: options.container ?? 'right',
        ribbon: options.ribbon ?? true,
        initialSize: 280,
        closable: true,
        createView: ctx => new AgendaWidget(ctx, host),
      })

      api.commands.register({
        id: 'agenda:today',
        label: 'Ouvrir la note du jour',
        run: () => void open(dayKey(new Date())),
      })
      api.commands.register({
        id: 'agenda:yesterday',
        label: 'Ouvrir la note d\'hier',
        run: () => { const d = new Date(); d.setDate(d.getDate() - 1); void open(dayKey(d)) },
      })
      api.commands.register({
        id: 'agenda:tomorrow',
        label: 'Ouvrir la note de demain',
        run: () => { const d = new Date(); d.setDate(d.getDate() + 1); void open(dayKey(d)) },
      })
    },

    async onunload() {},
  }
}

export { dailyNotes, dailyNotePath, dailyTemplatePath, dayKey, monthGrid } from './daily'
export default createAgendaPlugin()
