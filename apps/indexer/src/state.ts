// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Etat global du pair, sur disque : ou il en est du flux (epoque, position
// sure). Ecrit de facon atomique (fichier temporaire, fsync, renommage) : un
// arret brutal laisse l'ancienne version ou la nouvelle, jamais un melange.
// Chaque index garde aussi sa propre sequence et son epoque : sans ce
// fichier, le pair repart de zero sur le flux sans rien reconstruire de sain.
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { join } from 'node:path'

export interface PeerState {
  version: 1
  name: string
  epoch?: string
  cursor: number
  savedAt?: string
}

export const STATE_FILE = 'indexer-state.json'

export function loadState(dataDir: string): PeerState | undefined {
  try {
    const s = JSON.parse(readFileSync(join(dataDir, STATE_FILE), 'utf8')) as Partial<PeerState>
    if (s.version !== 1 || typeof s.name !== 'string' || typeof s.cursor !== 'number' || s.cursor < 0) return undefined
    return { version: 1, name: s.name, cursor: s.cursor, ...(typeof s.epoch === 'string' ? { epoch: s.epoch } : {}) }
  } catch {
    return undefined
  }
}

export function saveState(dataDir: string, state: PeerState): void {
  const file = join(dataDir, STATE_FILE)
  const tmp = `${file}.${process.pid}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, JSON.stringify({ ...state, savedAt: new Date().toISOString() }))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, file)
}
