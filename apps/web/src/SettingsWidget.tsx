// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// SettingsWidget — écran de paramètres style Obsidian.
// Tabs: Plugins, Triggers, Thèmes.
// Enregistré comme vue dans le workspace (panel bottom ou center).

import { useState, useEffect } from 'react'
import type { Widget } from '@savoire/plugin-api'
import type { InputTrigger, TriggerRegistry } from '@savoire/plugin-api'
import type { PluginEntry, PluginLoader } from '@savoire/plugin-runtime'
import { t } from '@savoire/i18n'

// ── Themes ────────────────────────────────────────────────────────────────────

export interface Theme {
  id: string
  name: string
  preview: { bg: string; surface: string; accent: string; text: string }
}

const THEMES: Theme[] = [
  { id: 'light',     name: 'settings.theme.light',     preview: { bg: '#f8fafc', surface: '#ffffff', accent: '#0d9488', text: '#0f172a' } },
  { id: 'dark',      name: 'settings.theme.dark',      preview: { bg: '#1e1e2e', surface: '#181825', accent: '#2dd4bf', text: '#cdd6f4' } },
  { id: 'sepia',     name: 'settings.theme.sepia',     preview: { bg: '#f5f0e8', surface: '#faf7f2', accent: '#0f766e', text: '#3b2f1e' } },
  { id: 'solarized', name: 'settings.theme.solarized', preview: { bg: '#fdf6e3', surface: '#eee8d5', accent: '#2aa198', text: '#586e75' } },
]

const THEME_KEY = 'savoire-theme-v2'

function applyTheme(id: string): void {
  document.documentElement.setAttribute('data-theme', id)
}

function loadSavedTheme(): string {
  return localStorage.getItem(THEME_KEY) ?? 'light'
}

export function initTheme(): void {
  applyTheme(loadSavedTheme())
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
    applyTheme(id)
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
        <div style={{ fontSize: '1rem', fontWeight: 700, marginBottom: 12, color: 'var(--text)' }}>{t('app', 'settings.title')}</div>
        <div style={{ display: 'flex', gap: 0 }}>
          <button style={tabStyle(tab === 'plugins')}  onClick={() => setTab('plugins')}>{t('app', 'settings.tab.plugins')}</button>
          <button style={tabStyle(tab === 'triggers')} onClick={() => setTab('triggers')}>{t('app', 'settings.tab.triggers')}</button>
          <button style={tabStyle(tab === 'themes')}   onClick={() => setTab('themes')}>{t('app', 'settings.tab.themes')}</button>
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
    return <div style={{ color: 'var(--text-faint)', marginTop: 8 }}>{t('app', 'settings.plugins.empty')}</div>
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
                {t('app', 'settings.plugins.active')}
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
    return <div style={{ color: 'var(--text-faint)', marginTop: 8 }}>{t('app', 'settings.triggers.empty')}</div>
  }
  return (
    <div>
      <p style={{ color: 'var(--text-faint)', marginTop: 0, marginBottom: 12, fontSize: '0.78rem' }}>
        {t('app', 'settings.triggers.description')}
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left', color: 'var(--text-faint)', fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            <th style={{ padding: '4px 10px 6px 0' }}>{t('app', 'settings.triggers.col.char')}</th>
            <th style={{ padding: '4px 10px 6px' }}>{t('app', 'settings.triggers.col.plugin')}</th>
            <th style={{ padding: '4px 0 6px' }}>{t('app', 'settings.triggers.col.description')}</th>
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
        {t('app', 'settings.themes.description')}
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
                background: theme.preview.surface,
                color: theme.preview.text,
                cursor: 'pointer',
                textAlign: 'left',
                fontWeight: 600,
                fontSize: '0.82rem',
                transition: 'border-color 0.15s',
                boxShadow: active ? '0 0 0 3px var(--accent-dim)' : 'none',
              }}
            >
              <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                {[theme.preview.bg, theme.preview.surface, theme.preview.accent].map((c, i) => (
                  <div key={i} style={{ width: 14, height: 14, borderRadius: '50%', background: c, flexShrink: 0 }} />
                ))}
              </div>
              {t('app', theme.name as 'settings.theme.light')}
              {active && <div style={{ fontSize: '0.68rem', color: theme.preview.accent, marginTop: 4, fontWeight: 700 }}>✓ {t('app', 'settings.plugins.active')}</div>}
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
