// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Moteur de raccourcis clavier, sur le modele d'Obsidian :
//
//  - chaque commande (registre des commandes) declare ses raccourcis par
//    defaut ;
//  - la personne peut les remplacer, commande par commande ;
//  - une touche pressee declenche la premiere commande active qui y repond.
//
// Le moteur ne connait ni l'editeur ni le DOM : l'editeur lui passe les
// touches quand il a le focus (avec sa vue), l'application les autres (sans
// vue). Une commande d'edition est ignoree sans editeur.
//
// Plus tard : jeux de raccourcis par defaut selon le contexte (navigateur ou
// application de bureau), et sauvegarde des personnalisations dans les
// reglages de la personne (loadCustom / onChange suffisent a la brancher).
import type {
  Hotkey,
  HotkeyEvent,
  HotkeyHost,
  HotkeyModifier,
  PluginCommand,
  PluginCommandContext,
} from '@savoire/plugin-api'

export type HotkeyPlatform = 'mac' | 'other'

/** Ce dont le moteur a besoin du registre des commandes. */
export interface HotkeyCommandSource {
  /** Commandes actives (celles d'un plugin desactive sont exclues). */
  getAll(): PluginCommand[]
  /** Commande enregistree, active ou non : pour ses raccourcis par defaut. */
  getRegistered?(id: string): PluginCommand | undefined
}

export function detectPlatform(): HotkeyPlatform {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined
  const p = (nav as { userAgentData?: { platform?: string } } | undefined)?.userAgentData?.platform
    ?? nav?.platform ?? ''
  return /mac|iphone|ipad/i.test(p) ? 'mac' : 'other'
}

type Physical = 'Ctrl' | 'Meta' | 'Shift' | 'Alt'
const ORDER: Physical[] = ['Ctrl', 'Alt', 'Shift', 'Meta']

/** Modificateurs reels d'un raccourci, une fois 'Mod' resolu. */
function physicalModifiers(mods: HotkeyModifier[], platform: HotkeyPlatform): Set<Physical> {
  const out = new Set<Physical>()
  for (const m of mods) out.add(m === 'Mod' ? (platform === 'mac' ? 'Meta' : 'Ctrl') : m)
  return out
}

function normalizeKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key
}

/**
 * Touche d'un evenement. Lettres et chiffres sont lus sur la touche physique
 * quand le caractere produit ne convient pas : Maj+7 en AZERTY, Alt+lettre
 * sur Mac (qui produit un symbole).
 */
export function eventKey(e: Pick<HotkeyEvent, 'key' | 'code'>): string {
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(e.code ?? '')
  if (digit) return digit[1]
  const letter = /^Key([A-Z])$/.exec(e.code ?? '')
  if (letter && !/^[a-z]$/i.test(e.key)) return letter[1].toLowerCase()
  return normalizeKey(e.key)
}

export function matches(hotkey: Hotkey, e: HotkeyEvent, platform: HotkeyPlatform): boolean {
  if (normalizeKey(hotkey.key) !== eventKey(e)) return false
  const want = physicalModifiers(hotkey.modifiers, platform)
  return want.has('Ctrl') === e.ctrlKey
    && want.has('Meta') === e.metaKey
    && want.has('Shift') === e.shiftKey
    && want.has('Alt') === e.altKey
}

function sameHotkey(a: Hotkey, b: Hotkey, platform: HotkeyPlatform): boolean {
  if (normalizeKey(a.key) !== normalizeKey(b.key)) return false
  const ma = physicalModifiers(a.modifiers, platform)
  const mb = physicalModifiers(b.modifiers, platform)
  return ma.size === mb.size && [...ma].every(m => mb.has(m))
}

const MAC_SYMBOLS: Record<Physical, string> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' }
const LABELS: Record<Physical, string> = { Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Maj', Meta: 'Meta' }

export function formatHotkey(hotkey: Hotkey, platform: HotkeyPlatform): string {
  const mods = physicalModifiers(hotkey.modifiers, platform)
  const key = hotkey.key.length === 1 ? hotkey.key.toUpperCase() : hotkey.key
  const ordered = ORDER.filter(m => mods.has(m))
  if (platform === 'mac') return ordered.map(m => MAC_SYMBOLS[m]).join('') + key
  return [...ordered.map(m => LABELS[m]), key].join('+')
}

export class HotkeyManager implements HotkeyHost {
  private custom = new Map<string, Hotkey[]>()
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly commands: HotkeyCommandSource,
    private readonly platform: HotkeyPlatform = detectPlatform(),
  ) {}

  get(commandId: string): Hotkey[] {
    return this.custom.get(commandId) ?? this.getDefault(commandId)
  }

  getDefault(commandId: string): Hotkey[] {
    const cmd = this.commands.getRegistered?.(commandId)
      ?? this.commands.getAll().find(c => c.id === commandId)
    return cmd?.hotkeys ?? []
  }

  setCustom(commandId: string, hotkeys: Hotkey[] | null): void {
    if (hotkeys === null) this.custom.delete(commandId)
    else this.custom.set(commandId, hotkeys.map(h => ({ modifiers: [...h.modifiers], key: h.key })))
    this.notify()
  }

  getCustom(): Record<string, Hotkey[]> {
    return Object.fromEntries(this.custom)
  }

  loadCustom(custom: Record<string, Hotkey[]>): void {
    this.custom = new Map(Object.entries(custom))
    this.notify()
  }

  findConflicts(hotkey: Hotkey): string[] {
    return this.commands.getAll()
      .filter(c => this.get(c.id).some(h => sameHotkey(h, hotkey, this.platform)))
      .map(c => c.id)
  }

  format(hotkey: Hotkey): string {
    return formatHotkey(hotkey, this.platform)
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  handleKeyEvent(event: HotkeyEvent, context: PluginCommandContext): boolean {
    if (event.defaultPrevented) return false
    // AltGr (Ctrl+Alt sous Windows) sert a taper des caracteres : @, #, {...
    if (event.getModifierState?.('AltGraph')) return false
    // Une touche seule (sans Ctrl, Alt ni Cmd) sert a ecrire, sauf F1-F12.
    if (!event.ctrlKey && !event.metaKey && !event.altKey && !/^F\d{1,2}$/.test(event.key)) return false
    for (const cmd of this.commands.getAll()) {
      if (!this.get(cmd.id).some(h => matches(h, event, this.platform))) continue
      if (cmd.editor && !context.editorView) continue
      if (cmd.isAvailable && !cmd.isAvailable(context)) continue
      event.preventDefault()
      cmd.run(context)
      return true
    }
    return false
  }

  private notify(): void {
    for (const cb of [...this.listeners]) cb()
  }
}
