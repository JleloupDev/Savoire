// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Un fichier dont aucun plugin actif n'ouvre le type s'affiche sur une fiche
// en lecture seule. Jamais dans l'editeur Markdown : il ouvrirait un document
// vide a la place du fichier, et laisserait taper dedans.
import { describe, it, expect, vi } from 'vitest'
import { DocumentView, isOpenableWithoutPlugin } from '../../../../../packages/editor-core/src/DocumentView'
import type { FileTypeRegistry, VaultAPI } from '@savoire/plugin-api'

const emptyRegistry: FileTypeRegistry = {
  register: () => {}, unregister: () => {}, resolve: () => undefined, getAll: () => [],
} as unknown as FileTypeRegistry

const vault = { write: vi.fn() } as unknown as VaultAPI

function mount(path: string, unsupportedMessage?: string) {
  const container = document.createElement('div')
  const view = new DocumentView({ path, container, vault, fileTypeRegistry: emptyRegistry, vaultId: 'v1', unsupportedMessage })
  view.mount()
  return { view, container }
}

describe('DocumentView sans plugin pour le type', () => {
  it('seul le Markdown s\'ouvre sans plugin', () => {
    expect(isOpenableWithoutPlugin('md')).toBe(true)
    expect(isOpenableWithoutPlugin('table')).toBe(false)
  })

  it('affiche une fiche, pas un editeur', () => {
    const { view, container } = mount('budget.table')
    const card = container.querySelector('[data-testid="unsupported-file"]')
    expect(card?.textContent).toContain('.table')
    expect(container.querySelector('.cm-editor')).toBeNull()
    expect(view.controller).toBeNull()
    expect(vault.write).not.toHaveBeenCalled()
  })

  it('reprend le message fourni par l\'application', () => {
    const { container } = mount('budget.table', 'Plugin Tables désactivé.')
    expect(container.textContent).toBe('Plugin Tables désactivé.')
  })

  it('un type actif sans open() est confie a l\'editeur Markdown, pas a la fiche', () => {
    const registry = { ...emptyRegistry, resolve: (ext: string) => ext === 'wtf' ? { extension: 'wtf', label: 'WTF', icon: '?', create: async () => '' } : undefined } as unknown as FileTypeRegistry
    const container = document.createElement('div')
    const view = new DocumentView({ path: 'x.wtf', container, vault, fileTypeRegistry: registry, vaultId: 'v1' })
    view.mount()
    expect(container.querySelector('[data-testid="unsupported-file"]')).toBeNull()
    expect(view.controller).not.toBeNull()
    view.destroy()
  })

  it('se demonte proprement', () => {
    const { view, container } = mount('budget.table')
    view.destroy()
    expect(container.querySelector('[data-testid="unsupported-file"]')).toBeNull()
  })
})
