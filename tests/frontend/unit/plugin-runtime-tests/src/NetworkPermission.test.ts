// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// api.network : seulement les sites declares par le plugin, en https.
import { describe, it, expect } from 'vitest'
import { networkAllowed, type PluginAPI, type PluginPermission } from '@savoire/plugin-api'
import { PermissionFilteredAPI } from '@savoire/plugin-runtime'

function filtered(permissions: PluginPermission[], withNetwork = true) {
  const asked: string[] = []
  const inner = { network: withNetwork ? { fetchText: async (url: string) => { asked.push(url); return 'page' } } : undefined } as unknown as PluginAPI
  return { api: new PermissionFilteredAPI(inner, new Set(permissions)), asked }
}

describe('api.network', () => {
  it('networkAllowed : le site exact, ou tous', () => {
    expect(networkAllowed(['network:wol.jw.org'], 'https://wol.jw.org/fr/wol/b/r30/lp-f/nwt/1/1')).toBe(true)
    expect(networkAllowed(['network:wol.jw.org'], 'https://www.jw.org/')).toBe(false)
    expect(networkAllowed(['network:wol.jw.org'], 'http://wol.jw.org/')).toBe(false)
    expect(networkAllowed(['network:wol.jw.org'], 'https://a:b@wol.jw.org/')).toBe(false)
    expect(networkAllowed(['network:*'], 'https://example.org/')).toBe(true)
    expect(networkAllowed(['vault:read'], 'https://example.org/')).toBe(false)
  })

  it('un site declare passe, un autre est refuse', async () => {
    const { api, asked } = filtered(['network:wol.jw.org'])
    await expect(api.network!.fetchText('https://wol.jw.org/x')).resolves.toBe('page')
    await expect(api.network!.fetchText('https://example.org/')).rejects.toThrow('Permission denied')
    expect(asked).toEqual(['https://wol.jw.org/x'])
  })

  it('sans droit reseau : refuse ; sans hote capable : absent', () => {
    expect(() => filtered(['vault:read']).api.network).toThrow('Permission denied')
    expect(filtered(['network:*'], false).api.network).toBeUndefined()
  })
})
