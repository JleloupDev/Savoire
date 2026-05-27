// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ShareAccessPage } from '../../../../../apps/web/src/ShareAccessPage'
import { DocumentView } from './__mocks__/editor-core'
import type { ISharingAPI, SharedDocumentHandle } from '@savoire/application'

vi.mock('../../../../../apps/web/src/pluginRegistry', () => ({
  pluginRegistry: {},
}))

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const noop = () => () => {}

function makeHandle(overrides?: Partial<SharedDocumentHandle>): SharedDocumentHandle {
  return {
    crdt: {
      onLocalOp: noop,
      onLocalPresenceChanged: noop,
      onTextChange: noop,
      applyRemoteOp: () => {},
      applyRemotePresence: () => {},
      encodeLocalPresence: () => new Uint8Array(),
      getRemoteCursorPositions: () => [],
      getSnapshot: () => new Uint8Array(),
      getVersion: () => ({ clock: 0 }),
      dispose: () => {},
    },
    transport: {
      push: () => Promise.resolve(),
      pushPresence: () => Promise.resolve(),
      pushSnapshot: () => Promise.resolve(),
      onInit: noop,
      onRemoteOp: noop,
      onRemotePresence: noop,
      join: () => Promise.resolve(),
      disconnect: () => Promise.resolve(),
      getState: () => 'disconnected' as const,
    },
    sync: {
      openRoom: () => Promise.resolve({
        onSnapshot: noop,
        onPresence: noop,
        pushSnapshot: () => Promise.resolve(),
        updatePresence: () => Promise.resolve(),
        close: () => Promise.resolve(),
      }),
    },
    docId: 'd1',
    vaultId: 'v1',
    path: 'notes/hello.md',
    filename: 'hello.md',
    permission: 'read',
    accessToken: 'tok',
    dispose: vi.fn(),
    ...overrides,
  }
}

function makeSharingApi(result: SharedDocumentHandle | 'error'): ISharingAPI {
  return {
    openSharedDocument: vi.fn().mockImplementation(() =>
      result === 'error'
        ? Promise.reject(new Error('404'))
        : Promise.resolve(result)
    ),
    accessShareLink:     vi.fn(),
    getSharing:          vi.fn(),
    grantPermission:     vi.fn(),
    revokePermission:    vi.fn(),
    lookupUserByEmail:   vi.fn(),
    createShareLink:     vi.fn(),
    revokeShareLink:     vi.fn(),
  } as ISharingAPI
}

// ─── Render helper ────────────────────────────────────────────────────────────

let container: HTMLElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

async function renderPage(token: string, api: ISharingAPI) {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`/share/${token}`]}>
        <Routes>
          <Route path="/share/:token" element={<ShareAccessPage sharingApi={api} />} />
        </Routes>
      </MemoryRouter>
    )
    await new Promise(r => setTimeout(r, 0))
  })
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ShareAccessPage', () => {
  it('shows loading state while openSharedDocument is pending', async () => {
    const api: ISharingAPI = {
      ...makeSharingApi(makeHandle()),
      openSharedDocument: vi.fn().mockImplementation(() => new Promise(() => {})),
    }
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/share/tok']}>
          <Routes>
            <Route path="/share/:token" element={<ShareAccessPage sharingApi={api} />} />
          </Routes>
        </MemoryRouter>
      )
    })
    expect(container.textContent).toContain('Vérification du lien')
  })

  it('shows error message when openSharedDocument rejects', async () => {
    await renderPage('bad', makeSharingApi('error'))
    expect(container.textContent).toContain('Lien invalide ou expiré')
  })

  it('shows filename in top bar', async () => {
    await renderPage('tok', makeSharingApi(makeHandle({ filename: 'hello.md' })))
    expect(container.textContent).toContain('hello.md')
  })

  it('shows "Lecture seule" badge for read permission', async () => {
    await renderPage('tok', makeSharingApi(makeHandle({ permission: 'read' })))
    expect(container.textContent).toContain('Lecture seule')
  })

  it('shows "Édition" badge for write permission', async () => {
    await renderPage('tok', makeSharingApi(makeHandle({ permission: 'write' })))
    expect(container.textContent).toContain('Édition')
  })

  it('renders an editor for the document', async () => {
    await renderPage('tok', makeSharingApi(makeHandle({ docId: 'd1' })))
    expect(container.querySelector('[data-testid="editor-d1"]')).not.toBeNull()
  })
})

// ─── Editor props ─────────────────────────────────────────────────────────────

describe('ShareAccessPage — editor props', () => {
  it('read permission → editor is readOnly', async () => {
    await renderPage('tok', makeSharingApi(makeHandle({ permission: 'read' })))
    expect(container.querySelector('[data-doc-id="d1"]')?.getAttribute('data-readonly')).toBe('true')
  })

  it('write permission → editor is not readOnly', async () => {
    await renderPage('tok', makeSharingApi(makeHandle({ permission: 'write' })))
    expect(container.querySelector('[data-doc-id="d1"]')?.getAttribute('data-readonly')).toBe('false')
  })

  it('editor userId is "share"', async () => {
    await renderPage('tok', makeSharingApi(makeHandle()))
    expect(container.querySelector('[data-doc-id="d1"]')?.getAttribute('data-user-id')).toBe('share')
  })
})

// ─── File type routing ────────────────────────────────────────────────────────

describe('ShareAccessPage — file type routing', () => {
  beforeEach(() => { DocumentView.lastOptions = {} })

  it('excalidraw handler is registered in fileTypeRegistry for .excalidraw file', async () => {
    await renderPage('tok', makeSharingApi(makeHandle({ path: 'diagram.excalidraw', filename: 'diagram.excalidraw' })))
    const registry = DocumentView.lastOptions.fileTypeRegistry as { resolve(ext: string): unknown }
    expect(registry.resolve('excalidraw')).toBeDefined()
  })

  it('mindmap handler is registered in fileTypeRegistry for .mindmap file', async () => {
    await renderPage('tok', makeSharingApi(makeHandle({ path: 'map.mindmap', filename: 'map.mindmap' })))
    const registry = DocumentView.lastOptions.fileTypeRegistry as { resolve(ext: string): unknown }
    expect(registry.resolve('mindmap')).toBeDefined()
  })

  it('markdown file has no custom handler — falls back to built-in editor', async () => {
    await renderPage('tok', makeSharingApi(makeHandle({ path: 'notes/hello.md', filename: 'hello.md' })))
    const registry = DocumentView.lastOptions.fileTypeRegistry as { resolve(ext: string): unknown }
    expect(registry.resolve('md')).toBeUndefined()
  })

  it('correct path is passed to DocumentView for each file type', async () => {
    for (const [path, filename] of [
      ['notes/hello.md', 'hello.md'],
      ['diagram.excalidraw', 'diagram.excalidraw'],
      ['map.mindmap', 'map.mindmap'],
    ]) {
      await renderPage('tok', makeSharingApi(makeHandle({ path, filename })))
      expect(DocumentView.lastOptions.path).toBe(path)
      await act(async () => { root.unmount() })
      container.remove()
      container = document.createElement('div')
      document.body.appendChild(container)
      root = createRoot(container)
    }
  })

  it('filename in top bar matches handle.filename', async () => {
    await renderPage('tok', makeSharingApi(makeHandle({ path: 'diagram.excalidraw', filename: 'diagram.excalidraw' })))
    expect(container.textContent).toContain('diagram.excalidraw')
  })
})

// ─── CRDT wiring ──────────────────────────────────────────────────────────────

describe('ShareAccessPage — CRDT wiring', () => {
  it('editor receives a crdt instance', async () => {
    await renderPage('tok', makeSharingApi(makeHandle()))
    expect(container.querySelector('[data-doc-id="d1"]')?.getAttribute('data-has-crdt')).toBe('true')
  })

  it('calls dispose on unmount', async () => {
    const handle = makeHandle()
    await renderPage('tok', makeSharingApi(handle))
    await act(async () => { root.unmount() })
    expect(handle.dispose).toHaveBeenCalled()
  })
})
