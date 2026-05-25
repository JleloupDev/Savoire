// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { useState, useEffect } from 'react'

interface VaultLike { read(docId: string): Promise<string> }

export function Editor({ docId, readOnly, userId, vault, crdt }: {
  docId: string
  readOnly?: boolean
  userId?: string
  vault?: VaultLike
  [key: string]: unknown
}) {
  const [content, setContent] = useState<string | null>(null)

  useEffect(() => {
    if (vault) {
      vault.read(docId).then(setContent).catch(() => setContent('ERROR'))
    }
  }, [docId, vault])

  return (
    <div
      data-testid={`editor-${docId}`}
      data-doc-id={docId}
      data-readonly={String(readOnly ?? false)}
      data-user-id={userId}
      data-content={content ?? ''}
    />
  )
}
