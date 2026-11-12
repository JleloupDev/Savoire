// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Paquets du Savoire Store : un JSON signe par le store.
//   { format: 1, id, kind, version, manifest, files: { "main.js": "..." } }
// Signature : ECDSA P-256 sur SHA-256, format IEEE P1363 (r||s), en base64,
// sur les octets exacts du paquet. La cle publique du store (SPKI, base64)
// est connue de l'application : un paquet qu'elle ne valide pas n'est jamais
// installe, ni charge (la verification est refaite a chaque demarrage).

export type StoreItemKind = 'plugin' | 'template' | 'module'

export interface StorePackage {
  format: 1
  id: string
  kind: StoreItemKind
  version: string
  manifest: {
    id: string
    name: string
    version: string
    description?: string
    author?: string
    permissions?: string[]
    [key: string]: unknown
  }
  files: Record<string, string>
}

export class StorePackageError extends Error {}

const b64 = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s)
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const hex = (buf: ArrayBuffer): string => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('')

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))
}

/** Identifiant court d'une cle (16 premiers caracteres hexa du SHA-256 de la SPKI), comme le store. */
export async function storeKeyId(spkiBase64: string): Promise<string> {
  return (await sha256Hex(b64(spkiBase64))).slice(0, 16)
}

/**
 * Verifie un paquet et le lit. Refuse : signature fausse, empreinte qui ne
 * correspond pas (si fournie), format inconnu, id ou version differents de
 * ceux attendus.
 */
export async function verifyStorePackage(
  bytes: Uint8Array,
  signatureBase64: string,
  publicKeySpkiBase64: string,
  expect: { id?: string; version?: string; sha256?: string } = {},
): Promise<StorePackage> {
  let key: CryptoKey
  try {
    key = await crypto.subtle.importKey('spki', b64(publicKeySpkiBase64), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  } catch {
    throw new StorePackageError('Clé du store illisible.')
  }
  let signature: Uint8Array<ArrayBuffer>
  try { signature = b64(signatureBase64) } catch { throw new StorePackageError('Signature illisible.') }
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, bytes as Uint8Array<ArrayBuffer>)
  if (!ok) throw new StorePackageError('Signature invalide : le paquet ne vient pas du Savoire Store, ou a été modifié.')
  if (expect.sha256 && (await sha256Hex(bytes)) !== expect.sha256.toLowerCase()) {
    throw new StorePackageError('Empreinte du paquet différente de celle annoncée.')
  }
  let pkg: StorePackage
  try { pkg = JSON.parse(new TextDecoder().decode(bytes)) as StorePackage } catch { throw new StorePackageError('Paquet illisible.') }
  if (pkg?.format !== 1 || typeof pkg.id !== 'string' || typeof pkg.version !== 'string' || !pkg.manifest || typeof pkg.files !== 'object') {
    throw new StorePackageError('Format de paquet inconnu.')
  }
  if (!['plugin', 'template', 'module'].includes(pkg.kind)) throw new StorePackageError(`Sorte inconnue : ${String(pkg.kind)}.`)
  if (expect.id && pkg.id !== expect.id) throw new StorePackageError('Le paquet ne correspond pas à l’élément demandé.')
  if (expect.version && pkg.version !== expect.version) throw new StorePackageError('Le paquet ne correspond pas à la version demandée.')
  if (pkg.manifest.id !== pkg.id || pkg.manifest.version !== pkg.version) throw new StorePackageError('Manifeste incohérent.')
  return pkg
}
