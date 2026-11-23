// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Onglet « Disposition » des parametres : la vue par defaut (Savoire,
// Obsidian, Notion, Developpeur), le type de fichier cree par defaut, les
// panneaux presents et les volets ouverts au demarrage. Tout s'applique tout de suite et reste sur ce poste.
import type { ViewGroup, ViewSpec } from '@savoire/plugin-api'
import { setShowEditorToolbar, setShowFileExtensions } from './displayPreferences'
import {
  LAYOUT_PRESETS, isLayoutModified, selectLayoutPreset, setPanelVisible, updateLayoutConfig, useLayoutPreferences,
} from './layoutPreferences'

export interface LayoutPanels { groups: ViewGroup[]; views: ViewSpec[] }

/** Un type de fichier qu'on peut creer : son extension et son nom. */
export interface CreatableFileType { extension: string; label: string }

/** Sans plugins charges (ou sans les pages) : les deux types de depart. */
const BASE_FILE_TYPES: CreatableFileType[] = [
  { extension: 'md', label: 'Note Markdown' },
  { extension: 'page', label: 'Page' },
]

type Side = 'left' | 'center' | 'right'

interface PanelRow { id: string; title: string; side: Side; children: { id: string; title: string }[] }

const small: React.CSSProperties = { color: 'var(--text-faint)', fontSize: '0.75rem' }
const section: React.CSSProperties = { fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-faint)', marginTop: 18, marginBottom: 8 }
const select: React.CSSProperties = { fontSize: '0.78rem', padding: '3px 6px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text)' }

const SIDES: { side: Side; label: string }[] = [
  { side: 'left', label: 'Volet gauche' },
  { side: 'center', label: 'Vues principales' },
  { side: 'right', label: 'Volet droit' },
]

/** Les panneaux tels qu'on les choisit : groupes (avec leurs vues) et vues seules. */
function panelRows({ groups, views }: LayoutPanels): PanelRow[] {
  const known = new Set(groups.map(g => g.id))
  const rows: PanelRow[] = groups.map(g => ({
    id: g.id, title: g.title, side: g.container,
    children: views.filter(v => v.groupId === g.id).map(v => ({ id: v.id, title: v.title })),
  }))
  for (const v of views) {
    if (v.id === 'editor-area' || (v.groupId && known.has(v.groupId))) continue
    rows.push({ id: v.id, title: v.title, side: v.container ?? 'left', children: [] })
  }
  return rows
}

export function LayoutSettings({ panels, applyPanes, fileTypes = [] }: { panels: LayoutPanels; applyPanes(): void; fileTypes?: CreatableFileType[] }) {
  const prefs = useLayoutPreferences()
  const { config } = prefs
  const modified = isLayoutModified(prefs)
  const hidden = new Set(config.hidden)
  const rows = panelRows(panels)
  const shown = (id: string) => !hidden.has(id)

  function choose(id: string) {
    const preset = selectLayoutPreset(id)
    setShowEditorToolbar(preset.display.editorToolbar)
    setShowFileExtensions(preset.display.showFileExtensions)
    applyPanes()
  }

  // Ce qui peut s'ouvrir au demarrage : les panneaux presents.
  const leftChoices = rows.filter(r => r.side === 'left' && shown(r.id))
  const rightChoices = rows.filter(r => r.side === 'right' && shown(r.id))
    .flatMap(r => r.children.length > 0 ? r.children.filter(c => shown(c.id)) : [{ id: r.id, title: r.title }])

  // Types proposes : ceux des plugins, et toujours le type choisi (plugin absent).
  const typeChoices = [...fileTypes]
  for (const t of [...BASE_FILE_TYPES, { extension: config.defaultFileType, label: `.${config.defaultFileType}` }]) {
    if (!typeChoices.some(c => c.extension === t.extension)) typeChoices.push(t)
  }

  return (
    <div data-testid="layout-settings">
      <div style={small}>
        Une vue par défaut donne un point de départ : les panneaux présents et ce qui s’ouvre au démarrage.
        Chaque réglage reste modifiable ci-dessous. Les choix restent sur ce poste.
      </div>

      <div style={section}>Vue par défaut</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
        {LAYOUT_PRESETS.map(p => {
          const active = p.id === prefs.presetId
          return (
            <button
              key={p.id}
              type="button"
              data-testid="layout-preset"
              data-preset-id={p.id}
              data-active={active ? 'true' : 'false'}
              onClick={() => choose(p.id)}
              style={{
                padding: '10px 14px', borderRadius: 10, textAlign: 'left', cursor: 'pointer',
                border: active ? '2px solid var(--accent)' : '2px solid var(--border)',
                background: 'var(--bg-surface)', color: 'var(--text)',
                boxShadow: active ? '0 0 0 3px var(--accent-dim)' : 'none',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: '0.82rem' }}>
                {p.name}
                {active && modified && <span data-testid="layout-modified" style={{ fontSize: '0.68rem', color: 'var(--text-faint)', fontWeight: 600 }}>modifiée</span>}
              </div>
              <div style={{ ...small, marginTop: 4 }}>{p.description}</div>
            </button>
          )
        })}
      </div>
      {modified && (
        <button type="button" data-testid="layout-reset" onClick={() => choose(prefs.presetId)}
          style={{ marginTop: 8, fontSize: '0.72rem', padding: '3px 10px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontWeight: 600 }}>
          Revenir aux réglages de la vue
        </button>
      )}

      <div style={section}>Type de fichier par défaut</div>
      <div style={{ ...small, marginBottom: 8 }}>
        Ce que créent « Nouvelle note » et le bouton de l’explorateur. Les autres types restent dans « Autres types de fichiers » et dans le menu « / ».
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        Créer par défaut :
        <select data-testid="layout-default-file-type" style={select} value={config.defaultFileType}
          onChange={e => updateLayoutConfig({ defaultFileType: e.target.value })}>
          {typeChoices.map(t => <option key={t.extension} value={t.extension}>{t.label}</option>)}
        </select>
      </label>

      <div style={section}>Au démarrage</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          Volet gauche :
          <select data-testid="layout-left-open" style={select} value={config.leftOpen ?? ''}
            onChange={e => updateLayoutConfig({ leftOpen: e.target.value || null })}>
            <option value="">Replié</option>
            {leftChoices.map(r => <option key={r.id} value={r.id}>{r.title}</option>)}
          </select>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input type="checkbox" data-testid="layout-right-open" checked={config.rightOpen}
            onChange={e => updateLayoutConfig({ rightOpen: e.target.checked })} />
          Volet droit déplié
        </label>
        {config.rightOpen && rightChoices.length > 1 && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            Panneau mis en avant à droite :
            <select data-testid="layout-right-focus" style={select} value={config.rightFocus ?? ''}
              onChange={e => updateLayoutConfig({ rightFocus: e.target.value || null })}>
              <option value="">Le premier</option>
              {rightChoices.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
            </select>
          </label>
        )}
      </div>

      <div style={section}>Panneaux présents</div>
      <div style={{ ...small, marginBottom: 8 }}>
        Un panneau retiré disparaît de l’espace de travail et de la barre d’icônes. L’éditeur reste toujours.
      </div>
      {SIDES.map(({ side, label }) => {
        const list = rows.filter(r => r.side === side)
        if (list.length === 0) return null
        return (
          <div key={side} style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>{label}</div>
            {list.map(r => (
              <div key={r.id}>
                <PanelCheckbox id={r.id} title={r.title} checked={shown(r.id)} />
                {r.children.length > 1 && r.children.map(c => (
                  <div key={c.id} style={{ marginLeft: 22 }}>
                    <PanelCheckbox id={c.id} title={c.title} checked={shown(c.id)} disabled={!shown(r.id)} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}

function PanelCheckbox({ id, title, checked, disabled }: { id: string; title: string; checked: boolean; disabled?: boolean }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1 }}>
      <input type="checkbox" data-testid="layout-panel" data-panel-id={id} checked={checked} disabled={disabled}
        onChange={e => setPanelVisible(id, e.target.checked)} />
      {title}
    </label>
  )
}
