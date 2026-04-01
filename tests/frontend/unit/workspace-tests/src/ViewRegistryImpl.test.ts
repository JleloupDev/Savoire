// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, vi } from 'vitest'
import { ViewRegistryImpl } from '@savoire/workspace'
import type { ViewSpec, ViewContext, Widget } from '@savoire/plugin-api'

function makeSpec(id: string, container = 'sidebar-left'): ViewSpec {
  return {
    id,
    title: id,
    container,
    createView: (_ctx: ViewContext): Widget => ({
      render: () => null,
    }),
  }
}

describe('ViewRegistryImpl', () => {
  it('registers a spec and returns it via getAll()', () => {
    const registry = new ViewRegistryImpl()
    const spec = makeSpec('filetree')
    registry.register(spec)
    expect(registry.getAll()).toEqual([spec])
  })

  it('returns spec by id via get()', () => {
    const registry = new ViewRegistryImpl()
    const spec = makeSpec('search')
    registry.register(spec)
    expect(registry.get('search')).toBe(spec)
  })

  it('returns undefined for unknown id', () => {
    const registry = new ViewRegistryImpl()
    expect(registry.get('nope')).toBeUndefined()
  })

  it('unregisters a spec', () => {
    const registry = new ViewRegistryImpl()
    registry.register(makeSpec('filetree'))
    registry.unregister('filetree')
    expect(registry.getAll()).toHaveLength(0)
  })

  it('getAll() returns all registered specs', () => {
    const registry = new ViewRegistryImpl()
    registry.register(makeSpec('a'))
    registry.register(makeSpec('b'))
    registry.register(makeSpec('c'))
    expect(registry.getAll()).toHaveLength(3)
  })

  it('overwriting a spec replaces the previous one', () => {
    const registry = new ViewRegistryImpl()
    const spec1 = { ...makeSpec('filetree'), title: 'v1' }
    const spec2 = { ...makeSpec('filetree'), title: 'v2' }
    registry.register(spec1)
    registry.register(spec2)
    expect(registry.get('filetree')?.title).toBe('v2')
    expect(registry.getAll()).toHaveLength(1)
  })

  it('createView is called with the provided context', () => {
    const registry = new ViewRegistryImpl()
    const createView = vi.fn((_ctx: ViewContext): Widget => ({ render: () => null }))
    registry.register({ id: 'v', title: 'V', container: 'left', createView })

    const ctx = {} as ViewContext
    registry.get('v')!.createView(ctx)
    expect(createView).toHaveBeenCalledWith(ctx)
  })
})
