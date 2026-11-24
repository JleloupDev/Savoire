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

type StoredDef = Omit<PropertyDef, 'key'>

const FORMATS: ReadonlySet<string> = new Set(['number', 'integer', 'decimal', 'percent', 'euro', 'dollar', 'pound', 'franc'])
const GROUPS: ReadonlySet<string> = new Set(['todo', 'doing', 'done'])

function readOption(o: unknown): PropertyOption | null {
  const x = o as Partial<PropertyOption> | null
  if (!x || typeof x.value !== 'string') return null
  const out: PropertyOption = { value: x.value }
  if (typeof x.color === 'string' && x.color) out.color = x.color
  if (typeof x.group === 'string' && GROUPS.has(x.group)) out.group = x.group
  return out
}

function readDef(key: string, value: unknown): PropertyDef | undefined {
  const v = value as Partial<StoredDef> | null
  if (!v || typeof v !== 'object' || !PROPERTY_TYPES.includes(v.type as PropertyType)) return undefined
  const def: PropertyDef = { key, type: v.type as PropertyType }
  if (typeof v.label === 'string' && v.label) def.label = v.label
  if (Array.isArray(v.options)) def.options = v.options.map(readOption).filter((o): o is PropertyOption => !!o)
  if (typeof v.format === 'string' && FORMATS.has(v.format)) def.format = v.format
  if (v.display === 'bar' || v.display === 'ring' || v.display === 'number') def.display = v.display
  if (typeof v.max === 'number' && Number.isFinite(v.max) && v.max > 0) def.max = v.max
  if (v.multiple === true) def.multiple = true
  if (typeof v.prefix === 'string' && v.prefix) def.prefix = v.prefix.slice(0, 20)
  const rel = v.relation as { base?: unknown; back?: unknown } | undefined
  if (rel && typeof rel.base === 'string' && rel.base) {
    def.relation = { base: rel.base, ...(typeof rel.back === 'string' && rel.back ? { back: rel.back } : {}) }
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
    if (def.options?.length) stored.options = def.options.map(o => ({ value: o.value, ...(o.color ? { color: o.color } : {}), ...(o.group ? { group: o.group } : {}) }))
    if (def.format) stored.format = def.format
    if (def.display) stored.display = def.display
    if (def.max !== undefined) stored.max = def.max
    if (def.multiple) stored.multiple = true
    if (def.prefix) stored.prefix = def.prefix
    if (def.relation?.base) stored.relation = { base: def.relation.base, ...(def.relation.back ? { back: def.relation.back } : {}) }
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
