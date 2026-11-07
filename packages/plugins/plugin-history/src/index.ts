// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Plugin core « Historique des versions » : voir history.ts. Le panneau
// « Versions » s'ouvre en onglet a cote de la revision.
import type { ISharedMap, PluginAPI, VaultPlugin } from '@savoire/plugin-api'
import { HISTORY_MAP, VersionRecorder, type NoteVersion } from './history'
import { HistoryWidget, type HistoryHost } from './HistoryWidget'

export { VersionRecorder, listVersions, diffLines, diffStats, HISTORY_MAP, VERSION_INTERVAL_MS, MAX_VERSIONS } from './history'
export type { NoteVersion, VersionAuthor, DiffLine } from './history'

const TICK_MS = 30_000

export function createHistoryPlugin(): VaultPlugin {
  let stop: (() => void) | null = null
  return {
    manifest: {
      id: 'plugin-history',
      name: 'Historique des versions',
      version: '0.0.1',
      description: 'Une version de chaque note toutes les 5 minutes pendant qu\'on écrit, avec son auteur ; comparer et restaurer',
      scope: 'vault',
      permissions: ['ui:editor', 'vault:read', 'vault:write'],
      defaultActive: true,
    },

    async onload(api: PluginAPI) {
      // Cle d'une note : son vault avec elle. Ce qui attend d'un autre vault
      // (on a change de vault entre-temps) n'est jamais ecrit dans celui-ci.
      const vaultId = () => api.vault.getVaultId?.() ?? ''
      const keyOf = (docId: string) => `${vaultId()}|${docId}`
      const mapOf = (key: string): ISharedMap | null => {
        const cut = key.indexOf('|')
        if (key.slice(0, cut) !== vaultId()) return null
        try { return api.vault.sharedData?.(key.slice(cut + 1)).openMap(HISTORY_MAP) ?? null } catch { return null }
      }
      const recorder = new VersionRecorder({
        openMap: mapOf,
        me: () => api.vault.getCurrentUser?.() ?? { id: 'local', name: 'Moi' },
      })

      api.hooks.onDocumentStabilized((docId, _path, content, _version, info) => {
        recorder.observe(keyOf(docId), content, !!info?.local)
      })

      const host: HistoryHost = {
        openMap: docId => mapOf(keyOf(docId)),
        flush: docId => recorder.flush(keyOf(docId)),
        restore: async (docId: string, version: NoteVersion) => {
          if (typeof api.vault.editText !== 'function') throw new Error('Ce vault ne permet pas de modifier la note.')
          await recorder.restore(keyOf(docId), version, (_key, text) => api.vault.editText!(docId, () => text))
        },
      }

      api.views.register({
        id: 'history',
        title: 'Versions',
        icon: 'history',
        container: 'right',
        tabOf: 'review',
        ribbon: true,
        initialSize: 300,
        closable: true,
        createView: ctx => new HistoryWidget(ctx, host),
      })

      // Quitter une note, cacher la fenetre : sa derniere frappe devient une version.
      const flushAll = () => recorder.flush()
      const onHidden = () => { if (document.visibilityState === 'hidden') flushAll() }
      const unsubActive = api.workspace.subscribeActiveDocument?.(flushAll)
      const timer = setInterval(() => recorder.tick(), TICK_MS)
      window.addEventListener('pagehide', flushAll)
      document.addEventListener('visibilitychange', onHidden)
      stop = () => {
        flushAll()
        unsubActive?.()
        clearInterval(timer)
        window.removeEventListener('pagehide', flushAll)
        document.removeEventListener('visibilitychange', onHidden)
      }
    },

    async onunload() {
      stop?.()
      stop = null
    },
  }
}

export default createHistoryPlugin()
