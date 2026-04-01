// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, expect, it } from 'vitest'
import { Account, Vault } from '@savoire/domain-sync'

describe('Account', () => {
  it('adds and gets vaults', () => {
    const a = new Account({ id: 'u1', displayName: 'User', email: 'u@example.com' })
    const v = new Vault({ id: 'v1', name: 'Main' })
    a.addVault(v)
    expect(a.getVault('v1')).toBe(v)
  })

  it('removes vaults', () => {
    const a = new Account({ id: 'u1', displayName: 'User', email: 'u@example.com' })
    a.addVault(new Vault({ id: 'v1', name: 'Main' }))
    a.removeVault('v1')
    expect(a.getVault('v1')).toBeUndefined()
  })

  it('returns vault list sorted by name', () => {
    const a = new Account({ id: 'u1', displayName: 'User', email: 'u@example.com' })
    a.addVault(new Vault({ id: 'v2', name: 'Zoo' }))
    a.addVault(new Vault({ id: 'v1', name: 'Alpha' }))
    expect(a.listVaults().map(v => v.name)).toEqual(['Alpha', 'Zoo'])
  })

  it('replaces vault with same id', () => {
    const a = new Account({ id: 'u1', displayName: 'User', email: 'u@example.com' })
    a.addVault(new Vault({ id: 'v1', name: 'A' }))
    a.addVault(new Vault({ id: 'v1', name: 'B' }))
    expect(a.listVaults()).toHaveLength(1)
    expect(a.getVault('v1')?.name).toBe('B')
  })

  it('rejects blank displayName', () => {
    expect(() => new Account({ id: 'u1', displayName: '   ', email: 'u@example.com' })).toThrow('displayName must not be empty')
  })

  it('rejects blank email', () => {
    expect(() => new Account({ id: 'u1', displayName: 'User', email: '   ' })).toThrow('email must not be empty')
  })

  // ── Coverage additions ────────────────────────────────────────────────────

  it('initializes with pre-populated vaults from constructor', () => {
    const v1 = new Vault({ id: 'v1', name: 'Alpha' })
    const v2 = new Vault({ id: 'v2', name: 'Beta' })
    const a = new Account({ id: 'u1', displayName: 'User', email: 'u@example.com', vaults: [v1, v2] })
    expect(a.listVaults()).toHaveLength(2)
    expect(a.getVault('v1')).toBe(v1)
    expect(a.getVault('v2')).toBe(v2)
  })

  it('listVaults returns empty array when no vaults added', () => {
    const a = new Account({ id: 'u1', displayName: 'User', email: 'u@example.com' })
    expect(a.listVaults()).toEqual([])
  })

  it('removeVault on non-existent id is a no-op', () => {
    const a = new Account({ id: 'u1', displayName: 'User', email: 'u@example.com' })
    expect(() => a.removeVault('non-existent')).not.toThrow()
  })

  it('getVault returns undefined for unknown id', () => {
    const a = new Account({ id: 'u1', displayName: 'User', email: 'u@example.com' })
    expect(a.getVault('missing')).toBeUndefined()
  })

  it('trims displayName and email whitespace', () => {
    const a = new Account({ id: 'u1', displayName: '  Alice  ', email: '  alice@example.com  ' })
    expect(a.displayName).toBe('Alice')
    expect(a.email).toBe('alice@example.com')
  })

  it('exposes id correctly', () => {
    const a = new Account({ id: 'user-42', displayName: 'User', email: 'u@example.com' })
    expect(a.id).toBe('user-42')
  })
})
