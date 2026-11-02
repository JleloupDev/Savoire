// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Cache de resultats, court : cle (vault, capacite, methode, parametres) et
// GENERATION de l'index du vault. Une entree ne sert que si l'index n'a pas
// bouge depuis (toute ecriture, tout changement d'etat fait avancer la
// generation) ; elle expire aussi apres TTL. Borne en nombre et en octets
// (LRU). Les resultats ne dependent pas de l'appelant tant qu'il n'y a pas
// de droits par note : le jour ou il y en aura, la cle devra les porter.

interface Entry {
  vaultId: string
  gen: number
  json: string
  at: number
}

export class ResultCache {
  private readonly map = new Map<string, Entry>()
  private bytes = 0
  hits = 0
  misses = 0
  evictions = 0

  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number,
    private readonly ttlMs: number,
  ) {}

  get enabled(): boolean {
    return this.maxEntries > 0 && this.maxBytes > 0 && this.ttlMs > 0
  }

  get size(): number {
    return this.map.size
  }

  get sizeBytes(): number {
    return this.bytes
  }

  static key(vaultId: string, capability: string, method: string, params: string): string {
    return `${vaultId}\u0000${capability}\u0000${method}\u0000${params}`
  }

  /** Le resultat (JSON) s'il est encore bon pour cette generation. */
  get(key: string, gen: number | undefined, now = Date.now()): string | undefined {
    if (!this.enabled) return undefined
    const e = this.map.get(key)
    if (!e || gen === undefined || e.gen !== gen || now - e.at > this.ttlMs) {
      if (e) this.drop(key, e)
      this.misses++
      return undefined
    }
    // Le plus recent a la fin.
    this.map.delete(key)
    this.map.set(key, e)
    this.hits++
    return e.json
  }

  set(key: string, vaultId: string, gen: number, json: string, now = Date.now()): void {
    if (!this.enabled) return
    const size = key.length + json.length
    if (size > this.maxBytes / 8) return // trop gros pour valoir la peine
    const old = this.map.get(key)
    if (old) this.drop(key, old)
    this.map.set(key, { vaultId, gen, json, at: now })
    this.bytes += size
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      const [k, e] = this.map.entries().next().value as [string, Entry]
      this.drop(k, e)
      this.evictions++
    }
  }

  /** Oublie tout un vault (supprime, plus a nous). */
  forgetVault(vaultId: string): void {
    for (const [k, e] of this.map) if (e.vaultId === vaultId) this.drop(k, e)
  }

  private drop(key: string, e: Entry): void {
    this.map.delete(key)
    this.bytes -= key.length + e.json.length
  }
}
