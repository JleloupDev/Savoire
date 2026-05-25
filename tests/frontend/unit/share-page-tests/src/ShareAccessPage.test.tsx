// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ShareAccessPage } from '../../../../../apps/web/src/ShareAccessPage'
import type { ISharingAPI, AppShareLinkAccess } from '@savoire/application'
import type { DocumentDto } from '../../../../../apps/web/src/types'

const mockListDocuments      = vi.hoisted(() => vi.fn().mockResolvedValue([]))
const mockGetDocumentContent = vi.hoisted(() => vi.fn().mockResolvedValue(''))

vi.mock('../../../../../apps/web/src/api', () => ({
  api: {
    listDocuments:      mockListDocuments,
    getDocumentContent: mockGetDocumentContent,
  },
}))

vi.mock('../../../../../apps/web/src/pluginRegistry', () => ({
  pluginRegistry: {},
}))

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const VAULT_READ: AppShareLinkAccess = {
  accessToken: 'tok',
  resourceType: 'vault',
  resourceId: 'v1',
  permission: 'read',
  expiresAt: null,
}

const VAULT_WRITE: AppShareLinkAccess = { ...VAULT_READ, permission: 'write' }

const DOC_READ: AppShareLinkAccess = {
  accessToken: 'tok',
  resourceType: 'document',
  resourceId: 'd1',
  permission: 'read',
  expiresAt: null,
  vaultId: 'v1',
}

function makeSharingApi(result: AppShareLinkAccess | 'error'): ISharingAPI {
  return {
    accessShareLink: vi.fn().mockImplementation(() =>
      result === 'error'
        ? Promise.reject(new Error('404'))
        : Promise.resolve(result)
    ),
    getSharing:         vi.fn(),
    grantPermission:    vi.fn(),
    revokePermission:   vi.fn(),
    lookupUserByEmail:  vi.fn(),
    createShareLink:    vi.fn(),
    revokeShareLink:    vi.fn(),
  } as ISharingAPI
}

// ─── Render helper ────────────────────────────────────────────────────────────

let container: HTMLElement
let root: Root

const DOC_FIXTURE: DocumentDto = {
  id: 'doc-42',
  path: 'notes/hello.md',
  title: 'Hello',
  hash: '',
  sizeBytes: 0,
  createdAt: '',
  updatedAt: '',
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  sessionStorage.clear()
  mockListDocuments.mockResolvedValue([])
  mockGetDocumentContent.mockResolvedValue('')
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
    // Flush: accessShareLink promise + listDocuments + vault.read()
    await new Promise(r => setTimeout(r, 0))
  })
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ShareAccessPage', () => {
  it('shows loading state while accessShareLink is pending', async () => {
    const api: ISharingAPI = {
      ...makeSharingApi(VAULT_READ),
      accessShareLink: vi.fn().mockImplementation(() => new Promise(() => {})),
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

  it('shows error message when accessShareLink rejects', async () => {
    await renderPage('bad', makeSharingApi('error'))
    expect(container.textContent).toContain('Lien invalide ou expiré')
  })

  it('shows "Vault partagé" in top bar for vault share', async () => {
    await renderPage('tok', makeSharingApi(VAULT_READ))
    expect(container.textContent).toContain('Vault partagé')
  })

  it('shows "Lecture seule" badge for read permission', async () => {
    await renderPage('tok', makeSharingApi(VAULT_READ))
    expect(container.textContent).toContain('Lecture seule')
  })

  it('shows "Édition" badge for write permission', async () => {
    await renderPage('tok', makeSharingApi(VAULT_WRITE))
    expect(container.textContent).toContain('Édition')
  })

  it('shows "Document partagé" in top bar for document share', async () => {
    await renderPage('tok', makeSharingApi(DOC_READ))
    expect(container.textContent).toContain('Document partagé')
  })

  it('stores access in sessionStorage after successful redemption', async () => {
    await renderPage('my-token', makeSharingApi(VAULT_READ))
    const cached = sessionStorage.getItem('share_access:my-token')
    expect(cached).not.toBeNull()
    const parsed = JSON.parse(cached!) as AppShareLinkAccess
    expect(parsed.resourceType).toBe('vault')
    expect(parsed.permission).toBe('read')
  })

  it('renders an editor for the document share view', async () => {
    await renderPage('tok', makeSharingApi(DOC_READ))
    expect(container.querySelector('[data-testid="editor-d1"]')).not.toBeNull()
  })
})

// ─── Editor props ─────────────────────────────────────────────────────────────

describe('ShareAccessPage — editor props', () => {
  it('document share read → editor is readOnly', async () => {
    await renderPage('tok', makeSharingApi(DOC_READ))
    const editor = container.querySelector('[data-doc-id="d1"]')
    expect(editor?.getAttribute('data-readonly')).toBe('true')
  })

  it('document share write → editor is not readOnly', async () => {
    const access: AppShareLinkAccess = { ...DOC_READ, permission: 'write' }
    await renderPage('tok', makeSharingApi(access))
    const editor = container.querySelector('[data-doc-id="d1"]')
    expect(editor?.getAttribute('data-readonly')).toBe('false')
  })

  it('document share → editor userId is "share"', async () => {
    await renderPage('tok', makeSharingApi(DOC_READ))
    const editor = container.querySelector('[data-doc-id="d1"]')
    expect(editor?.getAttribute('data-user-id')).toBe('share')
  })

  it('vault share read → editor is readOnly', async () => {
    mockListDocuments.mockResolvedValue([DOC_FIXTURE])
    await renderPage('tok', makeSharingApi(VAULT_READ))
    const editor = container.querySelector('[data-doc-id="doc-42"]')
    expect(editor?.getAttribute('data-readonly')).toBe('true')
  })

  it('vault share write → editor is not readOnly', async () => {
    mockListDocuments.mockResolvedValue([DOC_FIXTURE])
    await renderPage('tok', makeSharingApi(VAULT_WRITE))
    const editor = container.querySelector('[data-doc-id="doc-42"]')
    expect(editor?.getAttribute('data-readonly')).toBe('false')
  })
})

// ─── Vault API wiring ─────────────────────────────────────────────────────────

describe('ShareAccessPage — vault API wiring', () => {
  it('document share: getDocumentContent called with (vaultId, docId, token)', async () => {
    mockGetDocumentContent.mockResolvedValue('# Hello')
    await renderPage('tok', makeSharingApi(DOC_READ))
    expect(mockGetDocumentContent).toHaveBeenCalledWith('v1', 'd1', 'tok')
  })

  it('document share: editor receives content from vault.read()', async () => {
    mockGetDocumentContent.mockResolvedValue('# Hello World')
    await renderPage('tok', makeSharingApi(DOC_READ))
    const editor = container.querySelector('[data-doc-id="d1"]')
    expect(editor?.getAttribute('data-content')).toBe('# Hello World')
  })

  it('vault share: getDocumentContent called with vault resourceId as vaultId', async () => {
    mockListDocuments.mockResolvedValue([DOC_FIXTURE])
    mockGetDocumentContent.mockResolvedValue('vault content')
    await renderPage('tok', makeSharingApi(VAULT_READ))
    expect(mockGetDocumentContent).toHaveBeenCalledWith('v1', 'doc-42', 'tok')
  })

  it('vault share: editor receives content from vault.read()', async () => {
    mockListDocuments.mockResolvedValue([DOC_FIXTURE])
    mockGetDocumentContent.mockResolvedValue('vault content')
    await renderPage('tok', makeSharingApi(VAULT_READ))
    const editor = container.querySelector('[data-doc-id="doc-42"]')
    expect(editor?.getAttribute('data-content')).toBe('vault content')
  })
})

