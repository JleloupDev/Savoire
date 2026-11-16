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

  describe('panneaux retires par la disposition', () => {
    function setup() {
      const registry = new ViewRegistryImpl()
      registry.registerGroup({ id: 'tools', title: 'Outils', container: 'right' })
      registry.register({ ...makeSpec('backlinks'), groupId: 'tools' })
      registry.register(makeSpec('search'))
      registry.register({ ...makeSpec('editor-area'), container: 'center' })
      return registry
    }

    it('cache une vue retiree', () => {
      const registry = setup()
      registry.setHiddenIds(['search'])
      expect(registry.get('search')).toBeUndefined()
      expect(registry.getAll().map(v => v.id)).not.toContain('search')
      expect(registry._hiddenIds()).toContain('search')
    })

    it('cache un groupe retire et ses vues', () => {
      const registry = setup()
      registry.setHiddenIds(['tools'])
      expect(registry.getGroup('tools')).toBeUndefined()
      expect(registry.get('backlinks')).toBeUndefined()
      expect(registry._hiddenIds()).toEqual(expect.arrayContaining(['tools', 'backlinks']))
    })

    it('garde toujours l\'editeur', () => {
      const registry = setup()
      registry.setHiddenIds(['editor-area'])
      expect(registry.get('editor-area')).toBeDefined()
    })

    it('liste aussi les panneaux retires, pour les remettre', () => {
      const registry = setup()
      registry.setHiddenIds(['tools', 'search'])
      const { groups, views } = registry.listPanels()
      expect(groups.map(g => g.id)).toEqual(['tools'])
      expect(views.map(v => v.id)).toEqual(expect.arrayContaining(['backlinks', 'search']))
    })

    it('remet un panneau', () => {
      const registry = setup()
      registry.setHiddenIds(['search'])
      registry.setHiddenIds([])
      expect(registry.get('search')).toBeDefined()
    })
  })
})
