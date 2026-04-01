// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { useContext } from 'react'
import { EditorContext } from './EditorContext'
import type { EditorController } from '@savoire/editor-core'

export interface UseEditorResult {
  controller: EditorController | null
}

// useEditor exposes the EditorController to any component in the tree.
// Components must be descendants of <Editor />.
export function useEditor(): UseEditorResult {
  const controller = useContext(EditorContext)
  return { controller }
}
