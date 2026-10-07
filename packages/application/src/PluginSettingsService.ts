// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Catalogue des plugins : lesquels sont installes, lesquels sont actifs.
//
// Deux sortes d'entrees dans le catalogue :
//  - preinstallees : livrees et installees d'office (le coeur de Savoire) ;
//  - disponibles   : a installer depuis le store.
//
// Chaque plugin declare sa portee :
//  - 'vault'    : installation et activation vivent dans le vault (reglages
//                 partages de la session) et valent pour tous les membres ;
//  - 'personal' : elles vivent chez la personne (stockage fourni par l'app).
//
// Un plugin 'essential' n'est jamais desactivable. Desinstaller ou desactiver
// ne detruit rien : voir PluginActivation.
import type { IIndexChannel, PluginManifest, PluginScope } from '@savoire/plugin-api'
import type { IVaultSyncSession } from './contracts'

export interface PluginCatalogEntry {
  manifest: PluginManifest
  /** Installe d'office. Sinon : disponible dans le store, a installer. */
  preinstalled: boolean
}

export interface PluginInfo {
  id: string
  name: string
  description?: string
  version: string
  author?: string
  scope: PluginScope
  essential: boolean
  preinstalled: boolean
  installed: boolean
  enabled: boolean
}

/** Etat des plugins personnels, pour l'utilisateur courant. */
export interface PersonalPluginState {
  installed: string[]
  disabled: string[]
}

export interface IPersonalPluginStore {
  load(): PersonalPluginState
  save(state: PersonalPluginState): void
}

/** Sous-ensemble de PluginActivation (@savoire/plugin-runtime). */
export interface PluginActivationTarget {
  setDisabled(ids: Iterable<string>): void
}

/** Reglage d'un plugin de vault. Une cle absente garde la valeur par defaut. */
interface VaultPluginSetting {
  installed?: boolean
  enabled?: boolean
}

export class PluginSettingsService {
  private vaultSettings: IIndexChannel | null = null
  private unsubVault: (() => void) | null = null
  private personalState: PersonalPluginState
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly getCatalog: () => PluginCatalogEntry[],
    private readonly activation: PluginActivationTarget,
    private personal: IPersonalPluginStore,
  ) {
    this.personalState = personal.load()
    this.apply()
  }

  /** Change d'utilisateur : ses choix personnels remplacent les precedents. */
  setPersonalStore(personal: IPersonalPluginStore): void {
    this.personal = personal
    this.personalState = personal.load()
    this.apply()
  }

  /** Branche les reglages partages du vault actif. Undefined = aucun vault. */
  attachVault(session: IVaultSyncSession | undefined): void {
    this.unsubVault?.()
    this.unsubVault = null
    this.vaultSettings = session ? session.openVaultSettings('plugins') : null
    // Un membre installe ou coupe un plugin de vault : l'effet est immediat chez tous.
    if (this.vaultSettings) this.unsubVault = this.vaultSettings.onChange(() => this.apply())
    this.apply()
  }

  list(): PluginInfo[] {
    return this.getCatalog().map(({ manifest: m, preinstalled }) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      version: m.version,
      author: m.author,
      scope: scopeOf(m),
      essential: !!m.essential,
      preinstalled,
      installed: this.isInstalled(m.id),
      enabled: this.isEnabled(m.id),
    }))
  }

  /** Plugins installes : ceux que l'application doit avoir charges. */
  installedIds(): string[] {
    return this.getCatalog().map(e => e.manifest.id).filter(id => this.isInstalled(id))
  }

  /** Un plugin de vault ne se regle qu'avec un vault ouvert. */
  canChange(id: string): boolean {
    const entry = this.entry(id)
    if (!entry || entry.manifest.essential) return false
    return scopeOf(entry.manifest) === 'personal' || this.vaultSettings !== null
  }

  install(id: string): void {
    const entry = this.require(id)
    if (scopeOf(entry.manifest) === 'vault') {
      this.writeVault(id, { installed: true, enabled: true })
    } else {
      this.writePersonal({
        installed: union(this.personalState.installed, id),
        disabled: this.personalState.disabled.filter(x => x !== id),
      })
    }
    this.apply()
  }

  /** Seul un plugin du store se desinstalle ; le coeur se desactive seulement. */
  uninstall(id: string): void {
    const entry = this.require(id)
    if (entry.preinstalled) throw new Error(`${entry.manifest.name} est livre avec Savoire : desactivez-le plutot`)
    if (scopeOf(entry.manifest) === 'vault') {
      this.writeVault(id, { installed: false })
    } else {
      this.writePersonal({
        installed: this.personalState.installed.filter(x => x !== id),
        disabled: this.personalState.disabled,
      })
    }
    this.apply()
  }

  setEnabled(id: string, enabled: boolean): void {
    const entry = this.require(id)
    if (entry.manifest.essential) throw new Error(`${entry.manifest.name} est indispensable et ne peut pas etre desactive`)
    if (!this.isInstalled(id)) throw new Error(`${entry.manifest.name} n'est pas installe`)
    if (scopeOf(entry.manifest) === 'vault') {
      this.writeVault(id, { installed: true, enabled })
    } else {
      this.writePersonal({
        installed: this.personalState.installed,
        disabled: enabled
          ? this.personalState.disabled.filter(x => x !== id)
          : union(this.personalState.disabled, id),
      })
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

  // ── Interne ────────────────────────────────────────────────────────────────

  private entry(id: string): PluginCatalogEntry | undefined {
    return this.getCatalog().find(e => e.manifest.id === id)
  }

  private require(id: string): PluginCatalogEntry {
    const entry = this.entry(id)
    if (!entry) throw new Error(`plugin inconnu : ${id}`)
    return entry
  }

  private vaultSetting(id: string): VaultPluginSetting | undefined {
    return this.vaultSettings?.getAll().find(e => e.id === id)?.value as VaultPluginSetting | undefined
  }

  private writeVault(id: string, setting: VaultPluginSetting): void {
    if (!this.vaultSettings) throw new Error('ouvrez un vault pour regler ses plugins')
    this.vaultSettings.set(id, setting)
  }

  private writePersonal(state: PersonalPluginState): void {
    this.personalState = state
    this.personal.save(state)
  }

  private isInstalled(id: string): boolean {
    const entry = this.entry(id)
    if (!entry) return false
    if (entry.preinstalled) return true
    if (scopeOf(entry.manifest) === 'personal') return this.personalState.installed.includes(id)
    return this.vaultSetting(id)?.installed === true
  }

  private isEnabled(id: string): boolean {
    const entry = this.entry(id)
    if (!entry || !this.isInstalled(id)) return false
    if (entry.manifest.essential) return true
    if (scopeOf(entry.manifest) === 'personal') return !this.personalState.disabled.includes(id)
    return this.vaultSetting(id)?.enabled !== false
  }

  private apply(): void {
    // Tout ce qui n'est pas actif est filtre, y compris un plugin desinstalle
    // qui serait encore en memoire : il ne se decharge pas, il s'efface.
    const disabled = this.getCatalog().map(e => e.manifest.id).filter(id => !this.isEnabled(id))
    this.activation.setDisabled(disabled)
    for (const cb of [...this.listeners]) cb()
  }
}

/** Defaut prudent : un plugin qui ne se prononce pas est un plugin de vault. */
function scopeOf(m: PluginManifest): PluginScope {
  return m.scope ?? 'vault'
}

function union(list: string[], id: string): string[] {
  return list.includes(id) ? list : [...list, id]
}
