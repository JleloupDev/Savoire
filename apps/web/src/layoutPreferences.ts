// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Disposition de l'espace de travail (ce poste) : les panneaux presents, et ce
// qui s'ouvre au demarrage. Une « vue par defaut » (Savoire, Obsidian, Notion,
// Developpeur) donne un point de depart ; chaque reglage reste modifiable
// dans les options. Les panneaux se designent par l'id de leur vue ou de leur
// groupe (« explorer », « notes-tools », « review »...). Un id inconnu (plugin
// absent) ne gene pas : il est ignore.
//
// Les outils du developpeur (plugins actifs, metadonnees) ne sont presents que
// dans la vue Developpeur ; ailleurs on peut les rajouter a la main.

import { useSyncExternalStore } from 'react'

export interface LayoutConfig {
  /** Panneaux retires de l'espace de travail (vues ou groupes). */
  hidden: string[]
  /** Volet gauche au demarrage : groupe ou vue ouvert, null = replie. */
  leftOpen: string | null
  /** Volet droit deplie au demarrage. */
  rightOpen: boolean
  /** Panneau du volet droit mis en avant au demarrage, null = le premier. */
  rightFocus: string | null
}

export interface LayoutPreset {
  id: string
  name: string
  description: string
  config: LayoutConfig
  /** Reglages d'affichage poses quand on choisit cette vue (puis libres). */
  display: { editorToolbar: boolean; showFileExtensions: boolean }
}

/** Panneaux reserves a la vue Developpeur. */
const DEV_PANELS = ['plugin-inspector', 'metadata']

export const LAYOUT_PRESETS: LayoutPreset[] = [
  {
    id: 'savoire',
    name: 'Savoire',
    description: 'L\'explorateur à gauche, les outils de la note à droite.',
    config: { hidden: [...DEV_PANELS], leftOpen: 'explorer', rightOpen: true, rightFocus: null },
    display: { editorToolbar: true, showFileExtensions: false },
  },
  {
    id: 'obsidian',
    name: 'Obsidian',
    description: 'Fichiers, recherche et tags à gauche. Liens entrants à droite. Pas de barre d\'édition.',
    config: { hidden: ['review', 'history', 'agenda', ...DEV_PANELS], leftOpen: 'explorer', rightOpen: true, rightFocus: 'backlinks' },
    display: { editorToolbar: false, showFileExtensions: false },
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Une seule colonne de pages à gauche. La note prend la place. Commentaires et versions à la demande.',
    config: { hidden: ['notes-tools', 'hashtags', 'graph', ...DEV_PANELS], leftOpen: 'explorer', rightOpen: false, rightFocus: null },
    display: { editorToolbar: false, showFileExtensions: false },
  },
  {
    id: 'developer',
    name: 'Développeur',
    description: 'Tous les panneaux, dont les plugins actifs et les métadonnées. Plugins actifs ouverts à droite. Extensions des fichiers visibles.',
    config: { hidden: [], leftOpen: 'explorer', rightOpen: true, rightFocus: 'plugin-inspector' },
    display: { editorToolbar: false, showFileExtensions: true },
  },
]

export const DEFAULT_PRESET_ID = 'savoire'

export interface LayoutPreferences {
  /** Vue par defaut choisie : le point de depart des reglages. */
  presetId: string
  config: LayoutConfig
}

const KEY = 'savoire-layout'
/**
 * Version des reglages gardes. 2 : les outils du developpeur sortent des
 * autres vues ; un reglage plus ancien les perd une fois (rajoutables).
 */
const VERSION = 2
const listeners = new Set<() => void>()

export function presetById(id: string): LayoutPreset {
  return LAYOUT_PRESETS.find(p => p.id === id) ?? LAYOUT_PRESETS[0]
}

function copy(config: LayoutConfig): LayoutConfig {
  return { ...config, hidden: [...config.hidden] }
}

function defaults(): LayoutPreferences {
  return { presetId: DEFAULT_PRESET_ID, config: copy(presetById(DEFAULT_PRESET_ID).config) }
}

function read(): LayoutPreferences {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return defaults()
    const parsed = JSON.parse(raw) as Partial<LayoutPreferences> & { config?: Partial<LayoutConfig> }
    const preset = presetById(typeof parsed.presetId === 'string' ? parsed.presetId : DEFAULT_PRESET_ID)
    const c: Partial<LayoutConfig> = parsed.config ?? {}
    let hidden = Array.isArray(c.hidden) ? c.hidden.filter((x): x is string => typeof x === 'string') : [...preset.config.hidden]
    if ((parsed as { v?: number }).v !== VERSION && preset.id !== 'developer') {
      hidden = [...new Set([...hidden, ...DEV_PANELS])]
    }
    return {
      presetId: preset.id,
      config: {
        hidden,
        leftOpen: typeof c.leftOpen === 'string' || c.leftOpen === null ? c.leftOpen : preset.config.leftOpen,
        rightOpen: typeof c.rightOpen === 'boolean' ? c.rightOpen : preset.config.rightOpen,
        rightFocus: typeof c.rightFocus === 'string' || c.rightFocus === null ? c.rightFocus : preset.config.rightFocus,
      },
    }
  } catch { return defaults() }
}

let current = read()
// Garde le reglage relu a la version courante : la migration ne se fait qu'une fois.
try { if (localStorage.getItem(KEY)) localStorage.setItem(KEY, JSON.stringify({ v: VERSION, ...current })) } catch { /* navigation privee */ }

function write(next: LayoutPreferences): void {
  current = next
  try { localStorage.setItem(KEY, JSON.stringify({ v: VERSION, ...next })) } catch { /* navigation privee */ }
  for (const cb of [...listeners]) cb()
}

export function layoutPreferences(): LayoutPreferences {
  return current
}

/** Choisit une vue par defaut : ses reglages remplacent les reglages actuels. */
export function selectLayoutPreset(id: string): LayoutPreset {
  const preset = presetById(id)
  write({ presetId: preset.id, config: copy(preset.config) })
  return preset
}

/** Change un reglage. La vue par defaut reste, marquee comme modifiee. */
export function updateLayoutConfig(patch: Partial<LayoutConfig>): void {
  write({ presetId: current.presetId, config: { ...current.config, ...patch } })
}

export function setPanelVisible(id: string, visible: boolean): void {
  const hidden = current.config.hidden.filter(x => x !== id)
  if (!visible) hidden.push(id)
  updateLayoutConfig({ hidden })
}

/** Les reglages s'ecartent-ils de ceux de la vue par defaut choisie ? */
export function isLayoutModified(prefs: LayoutPreferences = current): boolean {
  const base = presetById(prefs.presetId).config
  const a = [...base.hidden].sort().join('\n')
  const b = [...prefs.config.hidden].sort().join('\n')
  return a !== b || base.leftOpen !== prefs.config.leftOpen || base.rightOpen !== prefs.config.rightOpen || base.rightFocus !== prefs.config.rightFocus
}

export function subscribeLayoutPreferences(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export function useLayoutPreferences(): LayoutPreferences {
  return useSyncExternalStore(subscribeLayoutPreferences, layoutPreferences)
}
