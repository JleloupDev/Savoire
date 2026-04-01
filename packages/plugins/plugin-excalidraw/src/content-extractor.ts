// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// ContentExtractor isomorphique — pas de dépendance à Excalidraw UI ni DOM.
// Exporté séparément pour permettre les tests unitaires sans charger Excalidraw.

import type { ContentExtractor } from '@savoire/plugin-api'

export const excalidrawContentExtractor: ContentExtractor = {
  toShadowDocument(rawContent: string): string {
    try {
      const parsed = JSON.parse(rawContent) as {
        elements?: Array<{ text?: string; type?: string }>
      }
      const texts = (parsed.elements ?? [])
        .filter(el => el.type === 'text' && typeof el.text === 'string' && el.text.trim())
        .map(el => el.text!.trim())
      return texts.length > 0 ? texts.join('\n\n') : ''
    } catch {
      return ''
    }
  },
}
