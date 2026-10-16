// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// FileContext.text et FileContext.tree ne sont donnes qu'aux types de plugin
// declares 'crdt'.
import { describe, it, expect, vi } from 'vitest'
import { DocumentView } from '../../../../../packages/editor-core/src/DocumentView'
import type { FileContext, FileTypeRegistry, FileTypeSpec, ISharedText, ISharedTree, VaultAPI } from '@savoire/plugin-api'

const vault = {} as unknown as VaultAPI
const sharedText = { toString: () => '' } as unknown as ISharedText
const sharedTree = { root: {} } as unknown as ISharedTree

function open(collaborationMode: FileTypeSpec['collaborationMode']) {
  let ctx: FileContext | undefined
  const spec = {
    extension: 'outline', label: 'Plan', icon: '-', create: async () => '', collaborationMode,
    open: (_path: string, c: FileContext) => { ctx = c; return { mount: () => {}, destroy: () => {} } },
  } as unknown as FileTypeSpec
  const registry = { resolve: () => spec } as unknown as FileTypeRegistry
  const openText = vi.fn(() => sharedText)
  const openTree = vi.fn(() => sharedTree)
  const view = new DocumentView({
    path: 'plan.outline', container: document.createElement('div'), vault,
    fileTypeRegistry: registry, vaultId: 'v1', openText, openTree,
  })
  view.mount()
  return { ctx, openText, openTree }
}

describe('DocumentView et texte partage', () => {
  it('un type crdt recoit le texte et l\'arbre du document', () => {
    const { ctx, openText, openTree } = open('crdt')
    expect(ctx?.text).toBe(sharedText)
    expect(ctx?.tree).toBe(sharedTree)
    expect(openText).toHaveBeenCalledTimes(1)
    expect(openTree).toHaveBeenCalledTimes(1)
  })

  it('un autre type ne les recoit pas, et rien n\'est ouvert', () => {
    const { ctx, openText, openTree } = open('lock')
    expect(ctx?.text).toBeUndefined()
    expect(ctx?.tree).toBeUndefined()
    expect(openText).not.toHaveBeenCalled()
    expect(openTree).not.toHaveBeenCalled()
  })
})
