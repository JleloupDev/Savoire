// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { type UpdateSource } from './enums'

export type AccountId = string
export type VaultId = string
export type DocumentId = string
export type UserId = string

export interface DocumentUpdate {
  updateId: string
  documentId: DocumentId
  source: UpdateSource
  payload: Uint8Array
  at: Date
}

export interface DocumentMeta {
  documentId: DocumentId
  name: string
  path: string
  updatedAt: Date
}

export interface ApplyResult {
  text: string
  versionDelta: number
}
