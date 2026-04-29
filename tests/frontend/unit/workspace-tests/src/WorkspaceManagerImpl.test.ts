// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WorkspaceManagerImpl } from '@savoire/workspace'
import type { WorkspacePort, WorkspaceLayout, PanelInstance } from '@savoire/workspace'

function makeMockPort(): WorkspacePort {
  const instance: PanelInstance = { id: 'mock', focus: vi.fn(), close: vi.fn() }
  return {
    openPanel: vi.fn(() => instance),
    closePanel: vi.fn(),
    focusPanel: vi.fn(),
    collapsePane: vi.fn(),
    expandPane: vi.fn(),
    getPaneWidth: vi.fn(() => 0),
    setPaneWidth: vi.fn(),
    saveLayout: vi.fn((): WorkspaceLayout => ({ panels: [] })),
    restoreLayout: vi.fn(),
    subscribeActivePanelChange: vi.fn(() => () => {}),
  }
}

describe('WorkspaceManagerImpl', () => {
  let port: WorkspacePort
  let manager: WorkspaceManagerImpl

  beforeEach(() => {
    port = makeMockPort()
    manager = new WorkspaceManagerImpl(port)
  })

  describe('openFile()', () => {
    it('opens the editor-area panel', async () => {
      await manager.openFile('notes/hello.md')
      expect(port.openPanel).toHaveBeenCalledWith('editor-area', { title: 'notes/hello.md' })
    })

    it('sets the active document path', async () => {
      await manager.openFile('notes/hello.md')
      expect(manager.getActiveDocument()?.path).toBe('notes/hello.md')
    })

    it('updates active document on subsequent openFile calls', async () => {
      await manager.openFile('a.md')
      await manager.openFile('b.md')
      expect(manager.getActiveDocument()?.path).toBe('b.md')
    })
  })

  describe('openPanel()', () => {
    it('delegates to port.openPanel', () => {
      manager.openPanel('sidebar-left')
      expect(port.openPanel).toHaveBeenCalledWith('sidebar-left')
    })
  })

  describe('closePanel()', () => {
    it('delegates to port.closePanel', () => {
      manager.closePanel('sidebar-left')
      expect(port.closePanel).toHaveBeenCalledWith('sidebar-left')
    })
  })

  describe('focusPanel()', () => {
    it('delegates to port.focusPanel', () => {
      manager.focusPanel('editor-area')
      expect(port.focusPanel).toHaveBeenCalledWith('editor-area')
    })
  })

  describe('getActiveDocument()', () => {
    it('returns undefined before any file is opened', () => {
      expect(manager.getActiveDocument()).toBeUndefined()
    })
  })

  describe('saveLayout()', () => {
    it('delegates to port.saveLayout and returns the result', () => {
      const layout: WorkspaceLayout = { panels: [{ id: 'p', location: 'left', views: [] }] }
      vi.mocked(port.saveLayout).mockReturnValueOnce(layout)
      expect(manager.saveLayout()).toEqual(layout)
    })
  })

  describe('restoreLayout()', () => {
    it('delegates to port.restoreLayout', () => {
      const layout: WorkspaceLayout = { panels: [] }
      manager.restoreLayout(layout)
      expect(port.restoreLayout).toHaveBeenCalledWith(layout)
    })
  })

  describe('views registry', () => {
    it('exposes a ViewRegistryImpl', () => {
      expect(manager.views).toBeDefined()
    })

    it('registered views are accessible via views.getAll()', () => {
      manager.views.register({
        id: 'filetree',
        title: 'Explorer',
        container: 'sidebar-left',
        createView: () => ({ render: () => null }),
      })
      expect(manager.views.getAll()).toHaveLength(1)
    })
  })
})
