// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// plugin-office : un document Office du vault est un lien vers sa version en
// ligne. Savoire ne stocke ni ne lit le contenu.
import { describe, it, expect, vi } from 'vitest'
import plugin, { describeLink, normalizeUrl, parseOfficeLink, serializeOfficeLink } from '@savoire/plugin-office'
import type { DocumentRoom, FileContext, FileTypeSpec, PluginAPI, VaultAPI } from '@savoire/plugin-api'

const tick = () => new Promise(r => setTimeout(r, 0))

describe('lien d\'un document Office', () => {
  it('un document vide ou invalide n\'est pas lie', () => {
    expect(parseOfficeLink('')).toBeNull()
    expect(parseOfficeLink('pas du json')).toBeNull()
    expect(parseOfficeLink('{"url":"javascript:alert(1)"}')).toBeNull()
  })

  it('aller-retour JSON', () => {
    const link = { url: 'https://contoso.sharepoint.com/:w:/r/budget.docx' }
    expect(parseOfficeLink(serializeOfficeLink(link))).toEqual(link)
  })

  it('n\'accepte que http et https', () => {
    expect(normalizeUrl('  https://example.org/doc ')).toBe('https://example.org/doc')
    expect(normalizeUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeUrl('data:text/html,x')).toBeNull()
    expect(normalizeUrl('pas une url')).toBeNull()
  })

  it('reconnait le service et l\'application', () => {
    expect(describeLink({ url: 'https://contoso.sharepoint.com/:x:/r/a.xlsx' }, 'xlsx'))
      .toEqual({ service: 'Microsoft 365', openLabel: 'Ouvrir dans Excel' })
    expect(describeLink({ url: 'https://1drv.ms/w/s!abc' }, 'docx'))
      .toEqual({ service: 'Microsoft 365', openLabel: 'Ouvrir dans Word' })
    expect(describeLink({ url: 'https://docs.google.com/presentation/d/xyz/edit' }, 'pptx'))
      .toEqual({ service: 'Google', openLabel: 'Ouvrir dans Google Slides' })
    expect(describeLink({ url: 'https://office.example.org/doc/42' }, 'odt'))
      .toEqual({ service: 'office.example.org', openLabel: 'Ouvrir le document' })
  })
})

// ── Vue ──────────────────────────────────────────────────────────────────────

function setup(initial = '') {
  const specs: FileTypeSpec[] = []
  const pushed: string[] = []
  let remote: ((json: string, from: string) => void) | undefined
  const room: DocumentRoom = {
    pushSnapshot: vi.fn(async (json: string) => { pushed.push(json) }),
    updatePresence: vi.fn(async () => {}),
    onSnapshot: (cb) => { remote = cb; return () => { remote = undefined } },
    onPresence: () => () => {},
    close: vi.fn(async () => {}),
  }
  const api = {
    files: { register: (s: FileTypeSpec) => specs.push(s) },
    sync: { openRoom: vi.fn(async () => room) },
  } as unknown as PluginAPI
  const vault = {
    readDocumentByPath: vi.fn(async () => initial),
    resolveDocumentId: () => 'doc-1',
    write: vi.fn(async () => {}),
  } as unknown as VaultAPI
  return { specs, pushed, api, vault, remote: (json: string) => remote?.(json, 'bob') }
}

async function open(env: ReturnType<typeof setup>, ext: string, readOnly = false) {
  await plugin.onload(env.api)
  const spec = env.specs.find(s => s.extension === ext)!
  const ctx: FileContext = { vaultId: 'v1', path: `budget.${ext}`, userId: 'alice', vault: env.vault, readOnly }
  const view = spec.open!(`budget.${ext}`, ctx)
  const el = document.createElement('div')
  view.mount(el)
  await tick(); await tick()
  return { view, el }
}

function submitUrl(el: HTMLElement, url: string) {
  ;(el.querySelector('[data-testid="office-url"]') as HTMLInputElement).value = url
  el.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
}

const q = (el: HTMLElement, id: string) => el.querySelector(`[data-testid="${id}"]`)

describe('plugin-office', () => {
  it('declare les formats Office et OpenDocument, sans verrou', async () => {
    const env = setup()
    await plugin.onload(env.api)
    expect(env.specs.map(s => s.extension)).toEqual(['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'])
    expect(new Set(env.specs.map(s => s.collaborationMode))).toEqual(new Set(['none']))
  })

  it('un document non lie propose de coller un lien', async () => {
    const { el } = await open(setup(), 'docx')
    expect(q(el, 'office-url')).not.toBeNull()
    expect(q(el, 'office-open')).toBeNull()
  })

  it('lier publie le lien et affiche le bouton d\'ouverture', async () => {
    const env = setup()
    const { el } = await open(env, 'docx')
    submitUrl(el, 'https://contoso.sharepoint.com/:w:/r/rapport.docx')
    await tick()
    expect(parseOfficeLink(env.pushed[0])).toEqual({ url: 'https://contoso.sharepoint.com/:w:/r/rapport.docx' })
    const openLink = q(el, 'office-open') as HTMLAnchorElement
    expect(openLink.textContent).toBe('Ouvrir dans Word')
    expect(openLink.getAttribute('href')).toBe('https://contoso.sharepoint.com/:w:/r/rapport.docx')
    expect(openLink.target).toBe('_blank')
    expect(openLink.rel).toBe('noopener noreferrer')
  })

  it('refuse un lien qui n\'est pas http(s), sans rien publier', async () => {
    const env = setup()
    const { el } = await open(env, 'docx')
    submitUrl(el, 'javascript:alert(1)')
    await tick()
    expect(env.pushed).toEqual([])
    expect(q(el, 'office-error')!.textContent).toMatch('https://')
  })

  it('en lecture seule : ouvrir oui, changer le lien non', async () => {
    const env = setup(serializeOfficeLink({ url: 'https://docs.google.com/document/d/x/edit' }))
    const { el, view } = await open(env, 'docx', true)
    expect(q(el, 'office-open')!.textContent).toBe('Ouvrir dans Google Docs')
    expect(q(el, 'office-change')).toBeNull()
    view.setReadOnly!(false)
    expect(q(el, 'office-change')).not.toBeNull()
  })

  it('un lien change par un autre membre s\'affiche sans recharger', async () => {
    const env = setup(serializeOfficeLink({ url: 'https://a.example.org/1' }))
    const { el } = await open(env, 'xlsx')
    env.remote(serializeOfficeLink({ url: 'https://contoso.sharepoint.com/:x:/r/b.xlsx' }))
    expect(q(el, 'office-open')!.textContent).toBe('Ouvrir dans Excel')
  })
})
