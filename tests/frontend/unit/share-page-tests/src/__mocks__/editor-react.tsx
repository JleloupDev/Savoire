// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
export function Editor({ docId, readOnly, userId, crdt }: {
  docId: string
  readOnly?: boolean
  userId?: string
  crdt?: unknown
  [key: string]: unknown
}) {
  return (
    <div
      data-testid={`editor-${docId}`}
      data-doc-id={docId}
      data-readonly={String(readOnly ?? false)}
      data-user-id={userId}
      data-has-crdt={crdt !== undefined ? 'true' : 'false'}
    />
  )
}
