// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Telecommande d'une presentation par telephone (protocole :
// plugin-api/slideRemote.ts). Ici, ce qui depend de l'appli :
//
//  - le transport : la room de la note sur le hub du serveur, par la
//    session du vault (sync.openRoom). Les messages passent dans la
//    presence, ephemere : rien n'est garde ;
//  - l'adresse que le telephone ouvre, et son souvenir le temps de la
//    connexion (le retour du fournisseur d'identite revient sur « / »).
import { isRemoteMessage, type DocumentRoom, type SlideRemoteLink, type SlideRemoteMessage, type SyncAPI } from '@savoire/plugin-api'

const STORAGE_KEY = 'savoire-slide-remote'
/** Le souvenir d'une telecommande ouverte vit le temps d'une presentation. */
const REMEMBER_MS = 3 * 60 * 60 * 1000

export interface SlideRemoteTarget {
  vaultId: string
  docId: string
  session: string
}

function storage(): Storage | null {
  try { return window.sessionStorage } catch { return null }
}

/**
 * La telecommande demandee par l'adresse (`?window=remote&...`), gardee pour
 * survivre a la connexion ; sinon celle gardee. null : appli normale.
 */
export function readSlideRemote(search: string = typeof window !== 'undefined' ? window.location.search : '', store: Pick<Storage, 'getItem' | 'setItem'> | null = storage()): SlideRemoteTarget | null {
  const q = new URLSearchParams(search)
  if (q.get('window') === 'remote') {
    const vaultId = q.get('vault'), docId = q.get('note'), session = q.get('session')
    if (!vaultId || !docId || !session) return null
    const target = { vaultId, docId, session }
    try { store?.setItem(STORAGE_KEY, JSON.stringify({ ...target, at: Date.now() })) } catch { /* plein */ }
    return target
  }
  try {
    const raw = store?.getItem(STORAGE_KEY)
    if (!raw) return null
    const t = JSON.parse(raw) as Partial<SlideRemoteTarget> & { at?: number }
    if (!t.vaultId || !t.docId || !t.session || !t.at || Date.now() - t.at > REMEMBER_MS) return null
    return { vaultId: t.vaultId, docId: t.docId, session: t.session }
  } catch {
    return null
  }
}

/** La telecommande est quittee : l'appli redevient normale au prochain chargement. */
export function forgetSlideRemote(): void {
  try { storage()?.removeItem(STORAGE_KEY) } catch { /* rien */ }
}

/** L'origine que le telephone peut ouvrir : la page, ou le serveur (appli de bureau). */
export function remoteOrigin(serverBase: string | null, loc: Pick<Location, 'protocol' | 'hostname' | 'origin'> = window.location): string {
  if (/^https?:$/.test(loc.protocol) && loc.hostname !== 'tauri.localhost') return loc.origin
  return serverBase || loc.origin
}

/** Un lien sur la room de la note : les messages d'une session, dans la presence. */
export function openRemoteLink(opts: {
  sync: SyncAPI
  vaultId: string
  docId: string
  userId: string
  session: string
  url: string
  local: boolean
}): SlideRemoteLink {
  const listeners = new Set<(m: SlideRemoteMessage) => void>()
  let room: DocumentRoom | null = null
  let closed = false
  let queue: SlideRemoteMessage[] = []
  const push = (r: DocumentRoom, m: SlideRemoteMessage) => { void r.updatePresence({ userId: opts.userId, slides: m }).catch(() => {}) }
  void opts.sync.openRoom(opts.vaultId, opts.docId, opts.userId).then(r => {
    if (closed) { void r.close(); return }
    room = r
    r.onPresence((_user, presence) => {
      const m = (presence as { slides?: unknown }).slides
      if (isRemoteMessage(m, opts.session)) for (const cb of listeners) cb(m)
    })
    for (const m of queue) push(r, m)
    queue = []
  }, err => console.warn('[telecommande] room indisponible', err))
  return {
    url: opts.url,
    local: opts.local,
    send(m) {
      if (closed) return
      if (room) push(room, m)
      else queue.push(m)
    },
    onMessage(cb) {
      listeners.add(cb)
      return () => { listeners.delete(cb) }
    },
    close() {
      if (closed) return
      closed = true
      listeners.clear()
      const r = room
      room = null
      // Le dernier message (fin, au revoir) part avant la fermeture.
      if (r) setTimeout(() => { void r.close() }, 300)
    },
  }
}
