// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// One-way CRDT -> disk materialization (spec §6.2). Nothing here ever reads a
// .md file back into the CRDT: these files are a read view, not an edit surface.
import { mkdir, writeFile, rm, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export async function writeDoc(vaultDir: string, path: string, content: string): Promise<void> {
  const full = join(vaultDir, path)
  await mkdir(dirname(full), { recursive: true })
  await writeFile(full, content, 'utf8')
}

export async function removeDoc(vaultDir: string, path: string): Promise<void> {
  try {
    await rm(join(vaultDir, path))
  } catch {
    // already absent
  }
}

export async function moveDoc(vaultDir: string, oldPath: string, newPath: string): Promise<void> {
  const to = join(vaultDir, newPath)
  await mkdir(dirname(to), { recursive: true })
  try {
    await rename(join(vaultDir, oldPath), to)
  } catch {
    // old file was never written (race with a fresh materialization) — nothing to move
  }
}
