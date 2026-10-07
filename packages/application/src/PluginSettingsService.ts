// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Quels plugins sont actifs. Chaque plugin declare sa portee :
//
//  - 'vault'    : l'etat vit dans le vault (reglages partages de la session).
//                 Le changer vaut pour tous les membres : l'UI avertit avant.
//  - 'personal' : l'etat vit chez la personne (stockage fourni par l'app).
//
// Un plugin 'essential' n'est jamais desactivable. Un plugin sans reglage est
// actif. Desactiver ne detruit rien : voir PluginActivation.
import type { IIndexChannel, PluginManifest, PluginScope } from '@savoire/plugin-api'
import type { IVaultSyncSession } from './contracts'

export interface PluginInfo {
  id: string
  name: string
  description?: string
  version: string
  author?: string
  scope: PluginScope
  essential: boolean
  enabled: boolean
}

/** Plugins personnels desactives, pour l'utilisateur courant. */
export interface IPersonalPluginStore {
  loadDisabled(): string[]
  saveDisabled(ids: string[]): void
}

/** Sous-ensemble de PluginActivation (@savoire/plugin-runtime). */
export interface PluginActivationTarget {
  setDisabled(ids: Iterable<string>): void
}

interface VaultPluginSetting { enabled: boolean }

export class PluginSettingsService {
  private vaultSettings: IIndexChannel | null = null
  private unsubVault: (() => void) | null = null
  private personalDisabled: Set<string>
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly getManifests: () => PluginManifest[],
    private readonly activation: PluginActivationTarget,
    private personal: IPersonalPluginStore,
  ) {
    this.personalDisabled = new Set(personal.loadDisabled())
    this.apply()
  }

  /** Change d'utilisateur : ses choix personnels remplacent les precedents. */
  setPersonalStore(personal: IPersonalPluginStore): void {
    this.personal = personal
    this.personalDisabled = new Set(personal.loadDisabled())
    this.apply()
  }

  /** Branche les reglages partages du vault actif. Undefined = aucun vault. */
  attachVault(session: IVaultSyncSession | undefined): void {
    this.unsubVault?.()
    this.unsubVault = null
    this.vaultSettings = session ? session.openVaultSettings('plugins') : null
    // Un membre change un plugin de vault : l'effet est immediat chez tous.
    if (this.vaultSettings) this.unsubVault = this.vaultSettings.onChange(() => this.apply())
    this.apply()
  }

  list(): PluginInfo[] {
    return this.getManifests().map(m => ({
      id: m.id,
      name: m.name,
      description: m.description,
      version: m.version,
      author: m.author,
      scope: scopeOf(m),
      essential: !!m.essential,
      enabled: this.isEnabled(m),
    }))
  }

  /** Un plugin de vault ne se regle qu'avec un vault ouvert. */
  canChange(id: string): boolean {
    const m = this.manifest(id)
    if (!m || m.essential) return false
    return scopeOf(m) === 'personal' || this.vaultSettings !== null
  }

  setEnabled(id: string, enabled: boolean): void {
    const m = this.manifest(id)
    if (!m) throw new Error(`plugin inconnu : ${id}`)
    if (m.essential) throw new Error(`${m.name} est indispensable et ne peut pas etre desactive`)
    if (scopeOf(m) === 'vault') {
      if (!this.vaultSettings) throw new Error('ouvrez un vault pour regler ses plugins')
      const setting: VaultPluginSetting = { enabled }
      this.vaultSettings.set(id, setting)
    } else {
      if (enabled) this.personalDisabled.delete(id)
      else this.personalDisabled.add(id)
      this.personal.saveDisabled([...this.personalDisabled])
    }
    this.apply()
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  dispose(): void {
    this.unsubVault?.()
    this.unsubVault = null
    this.vaultSettings = null
    this.listeners.clear()
  }

  private manifest(id: string): PluginManifest | undefined {
    return this.getManifests().find(m => m.id === id)
  }

  private isEnabled(m: PluginManifest): boolean {
    if (m.essential) return true
    if (scopeOf(m) === 'personal') return !this.personalDisabled.has(m.id)
    const setting = this.vaultSettings?.getAll().find(e => e.id === m.id)?.value as VaultPluginSetting | undefined
    return setting?.enabled !== false
  }

  private apply(): void {
    const disabled = this.getManifests().filter(m => !this.isEnabled(m)).map(m => m.id)
    this.activation.setDisabled(disabled)
    for (const cb of [...this.listeners]) cb()
  }
}

/** Defaut prudent : un plugin qui ne se prononce pas est un plugin de vault. */
function scopeOf(m: PluginManifest): PluginScope {
  return m.scope ?? 'vault'
}
