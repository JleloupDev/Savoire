// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { useEffect, useState } from 'react'
import type { Widget } from '@savoire/plugin-api'
import type { WorkspaceManagerImpl, ActiveEditorInfo } from '@savoire/workspace'

// ─── Source badge colours ──────────────────────────────────────────────────

const SOURCE_COLOR: Record<string, string> = {
  workspace:   '#4b5563',  // grey   — always-on workspace plugin (views/filetree)
  default:     '#16a34a',  // green  — manifest.defaultActive
  extension:   '#7c3aed',  // purple — activated by file extension
  frontmatter: '#0891b2',  // cyan   — activated by note frontmatter
  inactive:    '#374151',  // dark   — loaded but not active for this note
}
const SOURCE_LABEL: Record<string, string> = {
  workspace:   'workspace',
  default:     'default',
  extension:   'ext',
  frontmatter: 'fm',
  inactive:    'off',
}

// ─── PluginInspectorPanel ─────────────────────────────────────────────────

function PluginInspectorPanel({ manager }: { manager: WorkspaceManagerImpl }) {
  const [info, setInfo] = useState<ActiveEditorInfo>({ filePath: null, plugins: [] })

  useEffect(() => {
    return manager.subscribeActiveEditor(setInfo)
  }, [manager])

  return (
    <div style={{
      height: '100%', overflowY: 'auto',
      padding: '12px 14px',
      background: 'var(--bg-surface, #1e1e2e)',
      color: 'var(--text, #ddd)',
      fontFamily: 'var(--font-ui, sans-serif)',
      fontSize: 13,
    }}>
      {/* Current file */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 10, color: 'var(--text-faint, #666)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Fichier actif
        </div>
        <div style={{ fontSize: 12, color: info.filePath ? 'var(--text)' : 'var(--text-faint)', wordBreak: 'break-all' }}>
          {info.filePath ?? '—'}
        </div>
      </div>

      {/* Plugin list */}
      <div>
        <div style={{ fontSize: 10, color: 'var(--text-faint, #666)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Plugins actifs ({info.plugins.length})
        </div>
        {info.plugins.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>Aucun plugin actif.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {info.plugins.map(p => {
              const color = SOURCE_COLOR[p.source] ?? '#555'
              const isInactive = p.source === 'inactive'
              return (
                <div key={p.id} style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '5px 8px', borderRadius: 6,
                  background: 'var(--bg-elevated, #252535)',
                  border: `1px solid ${color}33`,
                  opacity: isInactive ? 0.45 : 1,
                }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
                  <span style={{ flex: 1, fontSize: 12 }}>{p.id.replace(/^plugin-/, '')}</span>
                  <span style={{
                    fontSize: 10, padding: '1px 5px', borderRadius: 3,
                    background: `${color}22`, color, border: `1px solid ${color}55`,
                  }}>
                    {SOURCE_LABEL[p.source] ?? p.source}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Widget wrapper ───────────────────────────────────────────────────────

export class PluginInspectorWidget implements Widget {
  constructor(private readonly manager: WorkspaceManagerImpl) {}

  render() {
    return <PluginInspectorPanel manager={this.manager} />
  }

  dispose() {}
}
