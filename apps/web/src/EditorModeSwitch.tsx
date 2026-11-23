// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { t } from '@savoire/i18n'
import { setNoteEditorMode, useNoteEditorMode, type NoteEditorMode } from './displayPreferences'

/**
 * Mode d'edition des notes (ADR-030), au-dessus de l'editeur. Le changer
 * remonte les notes ouvertes dans le nouveau mode ; il reste le meme
 * reglage que dans les parametres. `value` : le mode affiche, s'il n'est pas
 * celui des parametres (page de partage : classique tant que rien n'est choisi).
 */
export function EditorModeSwitch({ value }: { value?: NoteEditorMode } = {}) {
  const preferred = useNoteEditorMode()
  const mode = value ?? preferred
  const modes: { id: NoteEditorMode; label: 'settings.editor.mode.classic' | 'settings.editor.mode.power' | 'settings.editor.mode.source'; hint: 'settings.editor.mode.classicHint' | 'settings.editor.mode.powerHint' | 'settings.editor.mode.sourceHint' }[] = [
    { id: 'classic', label: 'settings.editor.mode.classic', hint: 'settings.editor.mode.classicHint' },
    { id: 'power', label: 'settings.editor.mode.power', hint: 'settings.editor.mode.powerHint' },
    { id: 'source', label: 'settings.editor.mode.source', hint: 'settings.editor.mode.sourceHint' },
  ]
  const current = modes.find(m => m.id === mode) ?? modes[1]
  return (
    <select
      data-testid="editor-mode-select"
      aria-label={t('app', 'settings.editor.mode')}
      title={`${t('app', 'settings.editor.mode')} : ${t('app', current.hint)}`}
      value={mode}
      onChange={e => setNoteEditorMode(e.target.value as NoteEditorMode)}
      style={{
        flex: 'none', height: 26, padding: '0 6px', borderRadius: 6,
        border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-muted)',
        font: '500 12px var(--font-ui, Inter, system-ui, sans-serif)', cursor: 'pointer',
      }}
    >
      {modes.map(m => <option key={m.id} value={m.id} title={t('app', m.hint)}>{t('app', m.label)}</option>)}
    </select>
  )
}
