// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Un document Office dans le vault n'est qu'un LIEN vers sa version en ligne
// (Microsoft 365, Google, Collabora...). L'edition et la collaboration se font
// chez le service ; ses droits s'appliquent. Savoire ne stocke ni ne lit le
// contenu.
//
// Le lien est un petit JSON, document « snapshot » ordinaire : il passe par la
// session du vault comme tout le reste, et reste donc portable en P2P.

export interface OfficeLink {
  url: string
}

/** null = document cree, pas encore lie. */
export function parseOfficeLink(raw: string): OfficeLink | null {
  if (!raw.trim()) return null
  try {
    const v = JSON.parse(raw) as Partial<OfficeLink>
    if (typeof v.url !== 'string') return null
    const url = normalizeUrl(v.url)
    return url ? { url } : null
  } catch {
    return null
  }
}

export function serializeOfficeLink(link: OfficeLink): string {
  return JSON.stringify(link)
}

/**
 * URL saisie -> URL acceptee, ou null. Seuls http et https passent : un lien
 * `javascript:` deviendrait du code execute au clic sur « Ouvrir ».
 */
export function normalizeUrl(input: string): string | null {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  return url.toString()
}

// ── Services en ligne ─────────────────────────────────────────────────────────

type Kind = 'text' | 'sheet' | 'slides'

const KIND_BY_EXTENSION: Record<string, Kind> = {
  docx: 'text', odt: 'text',
  xlsx: 'sheet', ods: 'sheet',
  pptx: 'slides', odp: 'slides',
}

interface Service {
  /** Nom du service, affiche sur la fiche. */
  name: string
  matches(url: URL): boolean
  /** Application qui ouvrira le document, selon son genre. */
  app(kind: Kind | undefined, url: URL): string | undefined
}

const MICROSOFT_HOST = /(^|\.)(sharepoint\.com|onedrive\.live\.com|1drv\.ms|office\.com|office\.live\.com|officeapps\.live\.com)$/

const SERVICES: Service[] = [
  {
    name: 'Microsoft 365',
    matches: url => MICROSOFT_HOST.test(url.hostname),
    app: kind => kind && { text: 'Word', sheet: 'Excel', slides: 'PowerPoint' }[kind],
  },
  {
    name: 'Google',
    matches: url => url.hostname === 'docs.google.com' || url.hostname === 'drive.google.com',
    // Le chemin dit le genre mieux que l'extension : un .docx peut etre ouvert dans Google Docs.
    app: (_kind, url) =>
      url.pathname.startsWith('/document/') ? 'Google Docs'
      : url.pathname.startsWith('/spreadsheets/') ? 'Google Sheets'
      : url.pathname.startsWith('/presentation/') ? 'Google Slides'
      : 'Google Drive',
  },
]

export interface LinkDescription {
  /** Service reconnu, ou nom d'hote (Collabora, Nextcloud et autres instances auto-hebergees). */
  service: string
  /** Libelle du bouton d'ouverture. */
  openLabel: string
}

export function describeLink(link: OfficeLink, extension: string): LinkDescription {
  const url = new URL(link.url)
  const kind = KIND_BY_EXTENSION[extension]
  const service = SERVICES.find(s => s.matches(url))
  if (!service) return { service: url.hostname, openLabel: 'Ouvrir le document' }
  const app = service.app(kind, url)
  return { service: service.name, openLabel: app ? `Ouvrir dans ${app}` : 'Ouvrir le document' }
}
