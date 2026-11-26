// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Note rapide (widget Android, `?capture` dans l'adresse) : ce qui est tape
// part d'abord dans une file, dans le stockage du navigateur. L'ecran de saisie
// (apps/web/src/quickCapture) s'affiche avant le reste de l'appli et ne fait que
// remplir la file. Ce module la vide : quand un vault est ouvert, chaque note
// rapide va a la fin de la note du jour de sa date, puis sort de la file.
//
// Protocole avec l'ecran de saisie (les deux cotes le redisent, sans import
// commun, pour que l'ecran reste minuscule) :
//  - file : localStorage[QUICK_CAPTURE_KEY], tableau de CaptureEntry ;
//  - evenement window QUICK_CAPTURE_EVENT, detail :
//      { type: 'queued' }                 l'ecran a ajoute une note ;
//      { type: 'open' }                   ouvrir la note du jour ;
//      { type: 'done', id, path }         la note est ecrite ;
//      { type: 'error', id, message }     echec, elle reste dans la file ;
//      { type: 'ready', vault }           un vault peut recevoir les notes.

export const QUICK_CAPTURE_KEY = 'savoire-quick-capture'
export const QUICK_CAPTURE_EVENT = 'savoire-quick-capture'
/** Demande d'ouvrir la note du jour, posee avant que le vault soit pret. */
export const QUICK_CAPTURE_OPEN_KEY = 'savoire-quick-capture-open'

export interface CaptureEntry {
  id: string
  text: string
  /** Jour local de la saisie, `2026-11-25` : la note du jour visee. */
  day: string
  /** Heure de la saisie (ms). */
  at: number
}

export type CaptureEvent =
  | { type: 'queued' }
  | { type: 'open' }
  | { type: 'done'; id: string; path: string }
  | { type: 'error'; id: string; message: string }
  | { type: 'ready'; vault?: string }

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function isEntry(v: unknown): v is CaptureEntry {
  const e = v as Partial<CaptureEntry> | null
  return !!e && typeof e.id === 'string' && typeof e.text === 'string' && typeof e.day === 'string' && typeof e.at === 'number'
}

/** La file, dans l'ordre de saisie. Illisible : vide. */
export function readCaptureQueue(store: Store): CaptureEntry[] {
  try {
    const raw = store.getItem(QUICK_CAPTURE_KEY)
    const list: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list.filter(isEntry) : []
  } catch {
    return []
  }
}

/** Retire une note de la file (relue juste avant : l'ecran a pu en ajouter). */
export function removeCaptureEntry(store: Store, id: string): void {
  const rest = readCaptureQueue(store).filter(e => e.id !== id)
  if (rest.length) store.setItem(QUICK_CAPTURE_KEY, JSON.stringify(rest))
  else store.removeItem(QUICK_CAPTURE_KEY)
}

/**
 * Le texte ajoute a la note du jour : un element de liste qui commence par
 * l'heure (`- 14:32 Appeler Hugo`). Les lignes suivantes restent dans
 * l'element (decalees de deux espaces).
 */
export function captureMarkdown(entry: CaptureEntry): string {
  const d = new Date(entry.at)
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const lines = entry.text.replace(/\r\n?/g, '\n').trim().split('\n')
  return [`- ${time} ${lines[0]}`, ...lines.slice(1).map(l => (l.trim() ? `  ${l}` : ''))].join('\n')
}

/** Ajoute un bloc a la fin d'un texte Markdown, separe par une ligne vide (ou colle a une liste). */
export function appendBlock(md: string, block: string): string {
  if (md === '') return `${block}\n`
  const body = md.endsWith('\n') ? md : `${md}\n`
  // Le texte finit par une note rapide precedente (son element de liste, et
  // ses lignes suivantes decalees) ? La nouvelle suit sans ligne vide : la
  // liste reste une.
  const lines = body.trimEnd().split('\n')
  let k = lines.length - 1
  while (k > 0 && /^ {2,}\S/.test(lines[k])) k--
  const sameList = /^- \d{2}:\d{2} /.test(lines[k]) && block.startsWith('- ')
  if (sameList) return `${body.trimEnd()}\n${block}\n`
  return `${body.endsWith('\n\n') ? body : `${body}\n`}${block}\n`
}

export interface CaptureFlushDeps {
  store: Store
  /** Ecrit le bloc a la fin de la note du jour `day` ; rend son chemin. */
  append(day: string, markdown: string): Promise<string>
  /** Ouvre la note du jour (demande de l'ecran). */
  openToday(): Promise<void>
  emit(event: CaptureEvent): void
}

/**
 * Vide la file, une note apres l'autre, dans l'ordre. Une erreur arrete le
 * tour : la note reste dans la file (et les suivantes, pour garder l'ordre).
 */
export function createCaptureFlusher(deps: CaptureFlushDeps): { flush(): Promise<void>; handle(event: CaptureEvent): void } {
  let running: Promise<void> | null = null
  let again = false

  const run = async () => {
    for (;;) {
      again = false
      for (const entry of readCaptureQueue(deps.store)) {
        try {
          const path = await deps.append(entry.day, captureMarkdown(entry))
          removeCaptureEntry(deps.store, entry.id)
          deps.emit({ type: 'done', id: entry.id, path })
        } catch (err) {
          deps.emit({ type: 'error', id: entry.id, message: err instanceof Error ? err.message : String(err) })
          return
        }
      }
      if (deps.store.getItem(QUICK_CAPTURE_OPEN_KEY)) {
        deps.store.removeItem(QUICK_CAPTURE_OPEN_KEY)
        await deps.openToday().catch(() => {})
      }
      if (!again) return
    }
  }

  // `active` est pose avant le premier appel : un `queued` recu pendant la
  // partie synchrone du tour (avant que `running` soit connu) ne lance pas un
  // second tour en parallele.
  let active = false
  const flush = (): Promise<void> => {
    if (active) { again = true; return running ?? Promise.resolve() }
    active = true
    running = run().finally(() => { active = false; running = null })
    return running
  }

  return {
    flush,
    handle(event) {
      if (event.type === 'queued' || event.type === 'open') void flush()
    },
  }
}
