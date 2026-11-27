// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Chemins d'une application : elle ne voit que son dossier (celui de son
// fichier .app, sous-dossiers compris). Un chemin donne par l'application est
// relatif a ce dossier ; il ne peut pas en sortir.

/** Le dossier d'une application : celui de son fichier .app ('' : la racine). */
export function appFolderOf(appPath: string): string {
  const i = appPath.lastIndexOf('/')
  return i < 0 ? '' : appPath.slice(0, i)
}

/**
 * Un chemin relatif au dossier de l'application, nettoye. Leve une erreur
 * s'il sort du dossier, vise la corbeille ou est vide.
 */
export function normalizeAppPath(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('Chemin attendu (texte).')
  if (raw.length > 1024) throw new Error('Chemin trop long.')
  const parts: string[] = []
  for (const seg of raw.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (!parts.length) throw new Error(`Chemin hors du dossier de l'application : ${raw}`)
      parts.pop()
      continue
    }
    parts.push(seg)
  }
  if (!parts.length) throw new Error('Chemin vide.')
  if (parts[0] === '.trash') throw new Error('La corbeille ne fait pas partie de l\'application.')
  return parts.join('/')
}

/** Chemin du vault d'un chemin de l'application. */
export function vaultPathOf(folder: string, rel: string): string {
  return folder ? `${folder}/${rel}` : rel
}

/** Chemin de l'application d'un chemin du vault (null : hors du dossier). */
export function relPathOf(folder: string, vaultPath: string): string | null {
  if (!folder) return vaultPath.startsWith('.trash/') ? null : vaultPath
  return vaultPath.startsWith(`${folder}/`) ? vaultPath.slice(folder.length + 1) : null
}

/** Dossier d'un chemin relatif ('' : le dossier de l'application). */
export function dirOf(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i < 0 ? '' : rel.slice(0, i)
}

/** Resout `spec` (./x.js, ../lib/y.js) depuis le fichier `from` (chemin relatif). */
export function resolveRelative(from: string, spec: string): string | null {
  const base = dirOf(from)
  try {
    return normalizeAppPath(base ? `${base}/${spec}` : spec)
  } catch {
    return null
  }
}

/** Les fichiers de code charges avec l'application (modules, scripts, styles). */
export const CODE_EXTENSIONS = ['js', 'mjs', 'css'] as const

export function isCodeFile(rel: string): boolean {
  const ext = rel.split('.').pop()?.toLowerCase() ?? ''
  return (CODE_EXTENSIONS as readonly string[]).includes(ext)
}

/**
 * Imports relatifs d'un module (./x.js, ../y.js) -> « app/<chemin> », que la
 * carte d'import du cadre sait trouver (une adresse blob: ne sert pas de base
 * a un chemin relatif). Les imports nus (react...) ne changent pas.
 */
export function rewriteModuleImports(from: string, code: string): string {
  const fix = (spec: string) => {
    if (!spec.startsWith('./') && !spec.startsWith('../')) return null
    const target = resolveRelative(from, spec)
    return target ? `app/${target}` : null
  }
  return code
    // import x from './a.js' ; export { y } from '../b.js' ; import './c.js'
    .replace(/(\b(?:import|export)\b[^'"`;]*?\bfrom\s*|\bimport\s*)(['"])(\.{1,2}\/[^'"]+)\2/g, (all, head: string, q: string, spec: string) => {
      const t = fix(spec)
      return t ? `${head}${q}${t}${q}` : all
    })
    // import('./d.js')
    .replace(/(\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\2(\s*\))/g, (all, head: string, q: string, spec: string, tail: string) => {
      const t = fix(spec)
      return t ? `${head}${q}${t}${q}${tail}` : all
    })
}

/** Type MIME d'un fichier, pour savoire.files.url (images, sons, videos, polices). */
export function mimeOf(rel: string): string {
  const ext = rel.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm',
    woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf',
    json: 'application/json', geojson: 'application/geo+json', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css',
    txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', html: 'text/html', pdf: 'application/pdf',
  }
  return map[ext] ?? 'application/octet-stream'
}
