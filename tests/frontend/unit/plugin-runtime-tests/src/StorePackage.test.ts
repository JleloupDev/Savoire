// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, beforeAll } from 'vitest'
import { verifyStorePackage, sha256Hex, storeKeyId, StorePackageError } from '@savoire/plugin-runtime'

const b64 = (buf: ArrayBuffer | Uint8Array): string => Buffer.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf)).toString('base64')

let keys: CryptoKeyPair
let spki: string

beforeAll(async () => {
  keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  spki = b64(await crypto.subtle.exportKey('spki', keys.publicKey))
})

function packageBytes(over: Record<string, unknown> = {}): Uint8Array {
  const pkg = {
    format: 1, id: 'demo', kind: 'plugin', version: '1.0.0',
    manifest: { id: 'demo', name: 'Démo', version: '1.0.0', permissions: ['vault:read'] },
    files: { 'main.js': 'module.exports = { onload() {} }' },
    ...over,
  }
  return new TextEncoder().encode(JSON.stringify(pkg))
}

// WebCrypto signe deja au format IEEE P1363 (r||s), comme le store.
const sign = async (bytes: Uint8Array) => b64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, bytes as Uint8Array<ArrayBuffer>))

describe('verifyStorePackage', () => {
  it('lit un paquet signe par le store', async () => {
    const bytes = packageBytes()
    const pkg = await verifyStorePackage(bytes, await sign(bytes), spki, { id: 'demo', sha256: await sha256Hex(bytes) })
    expect(pkg.manifest.name).toBe('Démo')
    expect(pkg.files['main.js']).toContain('onload')
  })

  it('refuse un paquet modifie apres signature', async () => {
    const bytes = packageBytes()
    const signature = await sign(bytes)
    const tampered = packageBytes({ files: { 'main.js': 'fetch("https://evil.example")' } })
    await expect(verifyStorePackage(tampered, signature, spki)).rejects.toThrow(/Signature invalide/)
  })

  it('refuse une signature d une autre cle', async () => {
    const other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    const otherSpki = b64(await crypto.subtle.exportKey('spki', other.publicKey))
    const bytes = packageBytes()
    await expect(verifyStorePackage(bytes, await sign(bytes), otherSpki)).rejects.toBeInstanceOf(StorePackageError)
  })

  it('refuse une empreinte, un id ou un manifeste qui ne correspondent pas', async () => {
    const bytes = packageBytes()
    const signature = await sign(bytes)
    await expect(verifyStorePackage(bytes, signature, spki, { sha256: '00'.repeat(32) })).rejects.toThrow(/Empreinte/)
    await expect(verifyStorePackage(bytes, signature, spki, { id: 'autre' })).rejects.toThrow(/ne correspond pas/)
    const odd = packageBytes({ manifest: { id: 'autre', name: 'x', version: '1.0.0' } })
    await expect(verifyStorePackage(odd, await sign(odd), spki)).rejects.toThrow(/incohérent/)
    const kind = packageBytes({ kind: 'theme' })
    await expect(verifyStorePackage(kind, await sign(kind), spki)).rejects.toThrow(/Sorte inconnue/)
  })

  it('calcule l id de cle comme le store', async () => {
    expect(await storeKeyId(spki)).toMatch(/^[0-9a-f]{16}$/)
  })
})
