// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Barre d'etat sous la note, comme dans Obsidian : mots, caractères, temps
// de lecture, et les mots de la sélection quand il y en a une.

import { useEffect, useState } from 'react'
import { countWords, textStats } from '@savoire/editor-core'
import { useEditorContext } from './EditorContext'

interface Shown { words: number; characters: number; minutes: number; selected: number }

const fmt = (n: number) => n.toLocaleString('fr-FR')
const plural = (n: number, one: string, many: string) => `${fmt(n)} ${n > 1 ? many : one}`

export function StatusBar() {
  const ctrl = useEditorContext()
  const [shown, setShown] = useState<Shown | null>(null)

  useEffect(() => {
    if (!ctrl) { setShown(null); return }
    let timer: ReturnType<typeof setTimeout> | null = null
    const compute = () => {
      timer = null
      const s = textStats(ctrl.exportMarkdown())
      const sel = ctrl.getSelectionText()
      setShown({ words: s.words, characters: s.characters, minutes: s.readingMinutes, selected: sel ? countWords(sel) : 0 })
    }
    const schedule = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(compute, 250)
    }
    compute()
    const offs = [ctrl.on('documentChanged', schedule), ctrl.on('selectionChanged', schedule)]
    return () => {
      if (timer) clearTimeout(timer)
      for (const off of offs) off()
    }
  }, [ctrl])

  if (!shown) return null
  const parts = [
    ...(shown.selected > 0 ? [`${plural(shown.selected, 'mot sélectionné', 'mots sélectionnés')}`] : []),
    plural(shown.words, 'mot', 'mots'),
    plural(shown.characters, 'caractère', 'caractères'),
    ...(shown.minutes > 0 ? [`${fmt(shown.minutes)} min de lecture`] : []),
  ]
  return (
    <div
      data-testid="editor-status-bar"
      style={{
        display: 'flex', justifyContent: 'flex-end', gap: 14, flexShrink: 0,
        padding: '2px 12px', fontSize: 11.5, lineHeight: '18px',
        color: 'var(--text-faint)', borderTop: '1px solid var(--border)', background: 'var(--bg-surface)',
        userSelect: 'none', whiteSpace: 'nowrap', overflow: 'hidden',
      }}
    >
      {parts.map(p => <span key={p}>{p}</span>)}
    </div>
  )
}
