// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { createContext, useContext } from 'react'
import type { EditorController } from '@savoire/editor-core'

export const EditorContext = createContext<EditorController | null>(null)

export function useEditorContext(): EditorController | null {
  return useContext(EditorContext)
}
