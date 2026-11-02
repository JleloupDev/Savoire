// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Petits outils sans etat : attentes annulables, hachage, JSON stable,
// verrou, semaphore.

/** Attend `ms` ; rejette si le signal est annule. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error('annule')); return }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(timer); reject(signal!.reason ?? new Error('annule')) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** FNV-1a 32 bits (unites UTF-16) : repartition des vaults entre les fils d'execution. */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** Ids de vault acceptes : ils deviennent des noms de fichier. */
const VAULT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function isVaultId(id: unknown): id is string {
  return typeof id === 'string' && VAULT_ID.test(id) && !id.includes('..')
}

/** Noms de pouvoir et de methode (comme le backend). */
const NAME = /^[a-z][a-z0-9_-]{0,63}$/

export function isName(s: unknown): s is string {
  return typeof s === 'string' && NAME.test(s)
}

/** JSON aux cles triees : deux parametres egaux donnent la meme cle de cache. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(x => stableStringify(x === undefined ? null : x)).join(',')}]`
  const keys = Object.keys(v as Record<string, unknown>).filter(k => (v as Record<string, unknown>)[k] !== undefined).sort()
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`
}

/** Une tache a la fois (file d'attente de promesses). */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve()
  private waiting = 0

  get busy(): boolean {
    return this.waiting > 0
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    this.waiting++
    const next = this.tail.then(fn)
    this.tail = next.catch(() => undefined).finally(() => { this.waiting-- })
    return next
  }
}

/** Au plus `n` taches a la fois. */
export class Semaphore {
  private active = 0
  private readonly queue: (() => void)[] = []

  constructor(private n: number) {}

  get inUse(): number {
    return this.active
  }

  get waiting(): number {
    return this.queue.length
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.n) await new Promise<void>(resolve => this.queue.push(resolve))
    else this.active++
    try {
      return await fn()
    } finally {
      const next = this.queue.shift()
      if (next) next()
      else this.active--
    }
  }
}

/** Execute fn sur chaque element, `n` a la fois, dans l'ordre des resultats. */
export async function mapLimit<T, R>(items: readonly T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!, i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
  return out
}

export function errorInfo(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const e = err as Error & { code?: unknown; status?: unknown; cause?: unknown }
    return {
      name: e.name,
      message: e.message,
      ...(e.code !== undefined ? { code: e.code } : {}),
      ...(e.status !== undefined ? { status: e.status } : {}),
      ...(e.cause instanceof Error ? { cause: e.cause.message } : {}),
    }
  }
  return { message: String(err) }
}
