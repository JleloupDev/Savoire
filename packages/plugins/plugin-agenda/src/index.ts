// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Plugin core « Agenda » : un calendrier dans la barre de droite et une note
// par jour (`Journal/2026-11-07.md`), comme les notes quotidiennes
// d'Obsidian. Une note du jour neuve part du modele « Note du jour » du
// dossier des modeles s'il existe (variables : voir renderTemplate).
import type { PluginAPI, VaultPlugin } from '@savoire/plugin-api'
import { AgendaWidget, type AgendaHost } from './AgendaWidget'
import { adjacentDailyNote, dayKey } from './daily'
import { ensureDailyNote } from './dailyFile'
import { appendBlock, createCaptureFlusher, QUICK_CAPTURE_EVENT, type CaptureEvent } from './quickCapture'
import { agendaAgentTools } from './agentTools'
import { AGENDA_MANIFEST, allFiles } from './server'

/** Ouvre la note de ce jour ; la cree d'abord si besoin, depuis le modele. */
export async function openDailyNote(api: PluginAPI, key: string): Promise<string> {
  const { path } = await ensureDailyNote(api, key, await allFiles(api))
  await api.workspace.openFile(path)
  return path
}

/**
 * Note rapide (voir quickCapture.ts) : vide la file des notes tapees dans
 * l'ecran de saisie, maintenant et a chaque nouvelle note. Rend l'arret.
 */
function startQuickCapture(api: PluginAPI, open: (key: string) => Promise<void>): () => void {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return () => {}
  const emit = (detail: CaptureEvent) => window.dispatchEvent(new CustomEvent(QUICK_CAPTURE_EVENT, { detail }))
  const flusher = createCaptureFlusher({
    store: localStorage,
    append: async (day, markdown) => {
      if (typeof api.vault.editText !== 'function') throw new Error('Ce vault ne permet pas d’écrire dans une note.')
      const { path, id } = await ensureDailyNote(api, day, await allFiles(api))
      await api.vault.editText(id, md => appendBlock(md, markdown))
      return path
    },
    openToday: () => open(dayKey(new Date())),
    emit,
  })
  const onEvent = (e: Event) => flusher.handle((e as CustomEvent<CaptureEvent>).detail)
  // Une note restee dans la file (hors ligne, appli fermee trop tot) repart au retour du reseau.
  const onOnline = () => void flusher.flush()
  window.addEventListener(QUICK_CAPTURE_EVENT, onEvent)
  window.addEventListener('online', onOnline)
  emit({ type: 'ready' })
  void flusher.flush()
  return () => {
    window.removeEventListener(QUICK_CAPTURE_EVENT, onEvent)
    window.removeEventListener('online', onOnline)
  }
}

export function createAgendaPlugin(options: { container?: 'left' | 'right'; ribbon?: boolean } = {}): VaultPlugin {
  let stopCapture: (() => void) | null = null
  return {
    manifest: AGENDA_MANIFEST,

    async onload(api: PluginAPI) {
      const open = (key: string) => openDailyNote(api, key).then(() => {}, err => {
        api.workspace?.notify?.('danger', 'Note du jour', err instanceof Error ? err.message : String(err))
      })
      const host: AgendaHost = { files: () => allFiles(api), openDay: open }
      // Agents (ADR-033) : lire la note du jour, y ecrire.
      for (const tool of agendaAgentTools(api, () => allFiles(api))) api.agents?.registerTool(tool)

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

      // Comme Obsidian : la note du jour precedente ou suivante, depuis la note du jour ouverte.
      const step = (dir: 1 | -1) => async () => {
        const current = api.workspace?.getActiveDocument?.()?.path
        if (!current) return
        const target = adjacentDailyNote(await allFiles(api), current, dir)
        if (target) await api.workspace.openFile(target)
        else api.workspace?.notify?.('info', 'Note du jour', dir === 1 ? 'Pas de note du jour plus récente.' : 'Pas de note du jour plus ancienne.')
      }
      api.commands.register({ id: 'daily-notes:goto-prev', label: 'Note du jour précédente', run: step(-1) })
      api.commands.register({ id: 'daily-notes:goto-next', label: 'Note du jour suivante', run: step(1) })

      stopCapture?.()
      stopCapture = startQuickCapture(api, open)
    },

    async onunload() {
      stopCapture?.()
      stopCapture = null
    },
  }
}

export { adjacentDailyNote, dailyNotes, dailyNotePath, dailyTemplatePath, dayKey, monthGrid } from './daily'
export { appendBlock, captureMarkdown, createCaptureFlusher, readCaptureQueue, removeCaptureEntry, QUICK_CAPTURE_EVENT, QUICK_CAPTURE_KEY, QUICK_CAPTURE_OPEN_KEY, type CaptureEntry, type CaptureEvent } from './quickCapture'
export default createAgendaPlugin()
