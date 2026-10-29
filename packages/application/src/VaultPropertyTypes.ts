// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Types des proprietes du vault (comme `.obsidian/types.json`), partages
// entre les membres par les reglages du vault : une carte CRDT
// « propriete -> { type, options } » (session.openVaultSettings). Rien de
// propre au serveur : meme mecanique en pair a pair et sur le bureau. Deux
// membres qui typent deux proprietes differentes ne s'ecrasent pas ; sur la
// meme, le dernier gagne.
import { PROPERTY_TYPES } from '@savoire/plugin-api'
import type {
  IIndexChannel, IPropertyTypes, PropertyDef, PropertyMember, PropertyOption, PropertySchema, PropertyType,
} from '@savoire/plugin-api'
import type { IVaultSyncSession } from './contracts'

/** Section des reglages du vault qui porte les types. */
export const PROPERTY_TYPES_SECTION = 'properties'

interface StoredDef {
  type: PropertyType
  label?: string
  options?: PropertyOption[]
}

function readDef(key: string, value: unknown): PropertyDef | undefined {
  const v = value as Partial<StoredDef> | null
  if (!v || typeof v !== 'object' || !PROPERTY_TYPES.includes(v.type as PropertyType)) return undefined
  const def: PropertyDef = { key, type: v.type as PropertyType }
  if (typeof v.label === 'string' && v.label) def.label = v.label
  if (Array.isArray(v.options)) {
    def.options = v.options.filter(o => o && typeof o.value === 'string').map(o => (o.color ? { value: o.value, color: o.color } : { value: o.value }))
  }
  return def
}

export class VaultPropertyTypes implements IPropertyTypes {
  private channel: IIndexChannel | null = null
  private unsub: (() => void) | null = null
  private cache: Map<string, PropertyDef> | null = null
  private readonly listeners = new Set<() => void>()
  private membersSource: (() => Promise<PropertyMember[]>) | null = null

  /** Branche les reglages du vault actif. Undefined : aucun vault. */
  attachVault(session: IVaultSyncSession | undefined): void {
    this.unsub?.()
    this.unsub = null
    this.channel = session ? session.openVaultSettings(PROPERTY_TYPES_SECTION) : null
    this.cache = null
    if (this.channel) this.unsub = this.channel.onChange(() => { this.cache = null; this.emit() })
    this.emit()
  }

  /** Qui fournit la liste des membres (partage du vault), s'il y en a. */
  setMembersSource(source: (() => Promise<PropertyMember[]>) | null): void {
    this.membersSource = source
  }

  schema(): PropertySchema {
    return { properties: [...this.defs().values()] }
  }

  get(key: string): PropertyDef | undefined {
    return this.defs().get(key)
  }

  set(def: PropertyDef): void {
    if (!this.channel) throw new Error('Ouvrez un vault pour typer ses propriétés.')
    if (!PROPERTY_TYPES.includes(def.type)) throw new Error(`Type de propriété inconnu : ${def.type}`)
    const stored: StoredDef = { type: def.type }
    if (def.label) stored.label = def.label
    if (def.options?.length) stored.options = def.options
    this.channel.set(def.key, stored)
  }

  remove(key: string): void {
    this.channel?.delete(key)
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  async members(): Promise<PropertyMember[]> {
    if (!this.membersSource) return []
    try { return await this.membersSource() } catch { return [] }
  }

  dispose(): void {
    this.unsub?.()
    this.unsub = null
    this.channel = null
    this.listeners.clear()
  }

  private defs(): Map<string, PropertyDef> {
    if (this.cache) return this.cache
    const map = new Map<string, PropertyDef>()
    for (const { id, value } of this.channel?.getAll() ?? []) {
      const def = readDef(id, value)
      if (def) map.set(id, def)
    }
    this.cache = map
    return map
  }

  private emit(): void {
    for (const cb of [...this.listeners]) cb()
  }
}
