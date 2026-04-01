// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// SettingsWidget — écran de paramètres style Obsidian.
// Tabs: Plugins, Triggers, Thèmes.
// Enregistré comme vue dans le workspace (panel bottom ou center).

import { useState, useEffect } from 'react'
import type { Widget } from '@savoire/plugin-api'
import type { InputTrigger, TriggerRegistry } from '@savoire/plugin-api'
import type { PluginEntry, PluginLoader } from '@savoire/plugin-runtime'

// ── Themes ────────────────────────────────────────────────────────────────────

export interface Theme {
  id: string
  name: string
  vars: Record<string, string>
}

const THEMES: Theme[] = [
  {
    id: 'dark',
    name: 'Dark (défaut)',
    vars: {
      '--bg': '#0f0f17',
      '--bg-surface': '#16161e',
      '--bg-elevated': '#1e1e2e',
      '--text': '#cdd6f4',
      '--text-muted': '#a6adc8',
      '--text-faint': '#585b70',
      '--border': '#313244',
      '--accent': '#8b5cf6',
      '--accent-dim': 'rgba(139,92,246,0.15)',
    },
  },
  {
    id: 'light',
    name: 'Light',
    vars: {
      '--bg': '#f8f8f2',
      '--bg-surface': '#ffffff',
      '--bg-elevated': '#f0f0f5',
      '--text': '#1e1e2e',
      '--text-muted': '#4c4f69',
      '--text-faint': '#9ca0b0',
      '--border': '#ccd0da',
      '--accent': '#7c3aed',
      '--accent-dim': 'rgba(124,58,237,0.12)',
    },
  },
  {
    id: 'sepia',
    name: 'Sépia',
    vars: {
      '--bg': '#f5f0e8',
      '--bg-surface': '#faf7f2',
      '--bg-elevated': '#fff8ef',
      '--text': '#3b2f1e',
      '--text-muted': '#6b5744',
      '--text-faint': '#a08070',
      '--border': '#d6c9b5',
      '--accent': '#b45309',
      '--accent-dim': 'rgba(180,83,9,0.12)',
    },
  },
  {
    id: 'midnight',
    name: 'Midnight Blue',
    vars: {
      '--bg': '#0a0e1a',
      '--bg-surface': '#111827',
      '--bg-elevated': '#1e2a3a',
      '--text': '#e2e8f0',
      '--text-muted': '#94a3b8',
      '--text-faint': '#475569',
      '--border': '#1e40af33',
      '--accent': '#3b82f6',
      '--accent-dim': 'rgba(59,130,246,0.15)',
    },
  },
]

const THEME_KEY = 'poc-obsidian-theme'

function applyTheme(theme: Theme): void {
  const root = document.documentElement
  for (const [k, v] of Object.entries(theme.vars)) {
    root.style.setProperty(k, v)
  }
  const bg = theme.vars['--bg']
  if (bg) root.style.setProperty('--bg-base', bg)

  const text      = theme.vars['--text']       ?? 'inherit'
  const muted     = theme.vars['--text-muted'] ?? 'inherit'
  const bgBase     = bg ?? theme.vars['--bg-base']     ?? 'transparent'
  root.style.setProperty('--dv-activegroup-visiblepanel-tab-color',    text)
  root.style.setProperty('--dv-activegroup-hiddenpanel-tab-color',     text)
  root.style.setProperty('--dv-inactivegroup-visiblepanel-tab-color',  text)
  root.style.setProperty('--dv-inactivegroup-hiddenpanel-tab-color',   text)
  root.style.setProperty('--dv-tab-close-icon',                        muted)
  root.style.setProperty('--dv-activegroup-visiblepanel-tab-background-color',   bgBase)
  root.style.setProperty('--dv-activegroup-hiddenpanel-tab-background-color',    bgBase)
  root.style.setProperty('--dv-inactivegroup-visiblepanel-tab-background-color', bgBase)
  root.style.setProperty('--dv-inactivegroup-hiddenpanel-tab-background-color',  bgBase)
  root.style.setProperty('--dv-tabs-and-actions-container-background-color',     bgBase)
  root.style.setProperty('--dv-group-view-background-color',  bgBase)
  root.style.setProperty('--dv-background-color',             bgBase)
}

function loadSavedTheme(): string {
  return localStorage.getItem(THEME_KEY) ?? 'dark'
}

export function initTheme(): void {
  const id = loadSavedTheme()
  const theme = THEMES.find(t => t.id === id) ?? THEMES[0]
  applyTheme(theme)
}

// ── Component ─────────────────────────────────────────────────────────────────

type Tab = 'plugins' | 'triggers' | 'themes'

export function SettingsPanel({
  loader,
  triggers,
}: {
  loader: PluginLoader
  triggers: TriggerRegistry
}) {
  const [tab, setTab] = useState<Tab>('plugins')
  const [plugins, setPlugins] = useState<PluginEntry[]>([])
  const [triggerList, setTriggerList] = useState<InputTrigger[]>([])
  const [themeId, setThemeId] = useState<string>(loadSavedTheme)

  useEffect(() => {
    setPlugins(loader.getAll())
    setTriggerList(triggers.getAll())
  }, [loader, triggers])

  function selectTheme(id: string) {
    const theme = THEMES.find(t => t.id === id)
    if (!theme) return
    applyTheme(theme)
    localStorage.setItem(THEME_KEY, id)
    setThemeId(id)
  }

  const tabStyle = (active: boolean): React.CSSProperties => ({
    padding: '6px 16px',
    border: 'none',
    borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
    background: 'transparent',
    color: active ? 'var(--accent)' : 'var(--text-muted)',
    fontSize: '0.82rem',
    fontWeight: 600,
    cursor: 'pointer',
    letterSpacing: '0.03em',
  })

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', color: 'var(--text)', background: 'var(--bg)', fontSize: '0.82rem' }}>
      {/* Header */}
      <div style={{ padding: '16px 24px 0', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <div style={{ fontSize: '1rem', fontWeight: 700, marginBottom: 12, color: 'var(--text)' }}>Paramètres</div>
        <div style={{ display: 'flex', gap: 0 }}>
          <button style={tabStyle(tab === 'plugins')}  onClick={() => setTab('plugins')}>Plugins</button>
          <button style={tabStyle(tab === 'triggers')} onClick={() => setTab('triggers')}>Triggers</button>
          <button style={tabStyle(tab === 'themes')}   onClick={() => setTab('themes')}>Thèmes</button>
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px' }}>
        {tab === 'plugins'  && <PluginsTab  plugins={plugins} />}
        {tab === 'triggers' && <TriggersTab triggers={triggerList} />}
        {tab === 'themes'   && <ThemesTab   themeId={themeId} onSelect={selectTheme} />}
      </div>
    </div>
  )
}

// ── Plugins tab ───────────────────────────────────────────────────────────────

function PluginsTab({ plugins }: { plugins: PluginEntry[] }) {
  if (plugins.length === 0) {
    return <div style={{ color: 'var(--text-faint)', marginTop: 8 }}>Aucun plugin chargé.</div>
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {plugins.map(entry => {
        const manifest = entry.plugin?.manifest
        return (
          <div
            key={entry.id}
            style={{ padding: '10px 14px', borderRadius: 8, background: 'var(--bg-surface)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}
          >
            <div style={{ width: 36, height: 36, borderRadius: 8, background: 'var(--bg-elevated)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.1rem', flexShrink: 0 }}>
              🧩
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, color: 'var(--text)' }}>{manifest?.name ?? entry.id}</div>
              {manifest?.description && (
                <div style={{ color: 'var(--text-faint)', fontSize: '0.75rem', marginTop: 2 }}>{manifest.description}</div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
              {manifest?.version && (
                <span style={{ fontSize: '0.7rem', padding: '2px 7px', borderRadius: 10, background: 'var(--bg-elevated)', color: 'var(--text-muted)' }}>
                  v{manifest.version}
                </span>
              )}
              <span style={{ fontSize: '0.7rem', padding: '2px 7px', borderRadius: 10, background: 'rgba(34,197,94,0.12)', color: '#22c55e', fontWeight: 600 }}>
                Actif
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Triggers tab ──────────────────────────────────────────────────────────────

function TriggersTab({ triggers }: { triggers: InputTrigger[] }) {
  if (triggers.length === 0) {
    return <div style={{ color: 'var(--text-faint)', marginTop: 8 }}>Aucun trigger enregistré.</div>
  }
  return (
    <div>
      <p style={{ color: 'var(--text-faint)', marginTop: 0, marginBottom: 12, fontSize: '0.78rem' }}>
        Les triggers sont les séquences de caractères réservées par les plugins.
        Un conflit indique que deux plugins essaient d'utiliser le même caractère.
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left', color: 'var(--text-faint)', fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            <th style={{ padding: '4px 10px 6px 0' }}>Caractère</th>
            <th style={{ padding: '4px 10px 6px' }}>Plugin</th>
            <th style={{ padding: '4px 0 6px' }}>Description</th>
          </tr>
        </thead>
        <tbody>
          {triggers.map(t => (
            <tr key={t.id} style={{ borderBottom: '1px solid var(--border)' }}>
              <td style={{ padding: '7px 10px 7px 0' }}>
                <code style={{ fontSize: '0.8rem', padding: '2px 6px', borderRadius: 4, background: 'var(--bg-elevated)', color: 'var(--accent)', fontFamily: 'monospace' }}>
                  {t.character}
                </code>
              </td>
              <td style={{ padding: '7px 10px', color: 'var(--text-muted)' }}>{t.id}</td>
              <td style={{ padding: '7px 0', color: 'var(--text-faint)' }}>{t.description ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Themes tab ────────────────────────────────────────────────────────────────

function ThemesTab({ themeId, onSelect }: { themeId: string; onSelect: (id: string) => void }) {
  return (
    <div>
      <p style={{ color: 'var(--text-faint)', marginTop: 0, marginBottom: 16, fontSize: '0.78rem' }}>
        Sélectionnez un thème. La préférence est sauvegardée localement.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 }}>
        {THEMES.map(theme => {
          const active = theme.id === themeId
          return (
            <button
              key={theme.id}
              onClick={() => onSelect(theme.id)}
              style={{
                padding: '14px 16px',
                borderRadius: 10,
                border: active ? '2px solid var(--accent)' : '2px solid var(--border)',
                background: theme.vars['--bg-surface'] ?? '#fff',
                color: theme.vars['--text'] ?? '#000',
                cursor: 'pointer',
                textAlign: 'left',
                fontWeight: 600,
                fontSize: '0.82rem',
                transition: 'border-color 0.15s',
                boxShadow: active ? '0 0 0 3px var(--accent-dim)' : 'none',
              }}
            >
              <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                {['--bg', '--bg-surface', '--accent'].map(v => (
                  <div key={v} style={{ width: 14, height: 14, borderRadius: '50%', background: theme.vars[v] ?? '#888', flexShrink: 0 }} />
                ))}
              </div>
              {theme.name}
              {active && <div style={{ fontSize: '0.68rem', color: theme.vars['--accent'] ?? '#888', marginTop: 4, fontWeight: 700 }}>✓ Actif</div>}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Widget wrapper (implements plugin-api Widget) ─────────────────────────────

export class SettingsWidget implements Widget {
  constructor(
    private readonly loader: PluginLoader,
    private readonly triggers: TriggerRegistry,
  ) {}

  render() {
    return <SettingsPanel loader={this.loader} triggers={this.triggers} />
  }

  dispose() {}
}
