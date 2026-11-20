// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le commit de cette version et sa date, dans l'en-tete : on sait d'un coup
// d'oeil quelle version tourne. Les valeurs viennent du build (vite.config.ts).

declare const __SAVOIRE_COMMIT__: string
declare const __SAVOIRE_COMMIT_DATE__: string

export const BUILD_COMMIT: string = typeof __SAVOIRE_COMMIT__ === 'string' ? __SAVOIRE_COMMIT__ : ''
export const BUILD_COMMIT_DATE: string = typeof __SAVOIRE_COMMIT_DATE__ === 'string' ? __SAVOIRE_COMMIT_DATE__ : ''

export function formatBuildDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function BuildInfo({ color = 'var(--text-faint)' }: { color?: string }) {
  if (!BUILD_COMMIT) return null
  const date = formatBuildDate(BUILD_COMMIT_DATE)
  return (
    <span
      data-testid="build-info"
      title={`Commit ${BUILD_COMMIT}${date ? ` du ${date}` : ''}`}
      style={{ fontSize: 10.5, color, fontFamily: 'var(--font-mono, monospace)', whiteSpace: 'nowrap', userSelect: 'text' }}
    >
      {BUILD_COMMIT.slice(0, 7)}{date ? ` · ${date}` : ''}
    </span>
  )
}
