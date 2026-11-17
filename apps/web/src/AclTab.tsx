// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Partager → « Droits » d'une note ou d'un dossier. Par defaut, ils sont
// herites (du dossier au-dessus, puis du vault) : la liste grise dit qui a
// quoi, et d'ou cela vient. On peut :
//  - donner un autre droit a une personne, ici (lecture, ecriture, admin,
//    ou « aucun acces » pour exclure un membre) : le plus precis l'emporte ;
//  - cesser d'heriter : seuls les droits donnes ici valent pour ce niveau
//    et ce qu'il contient (le proprietaire et les administrateurs gardent tout).
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppAclTarget, AppAclView, AppUserLookup, IVaultSharing } from '@savoire/application'

const small: React.CSSProperties = { fontSize: '0.72rem', color: 'var(--text-faint)' }
const label: React.CSSProperties = { fontSize: '0.68rem', fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.08em' }
const sel: React.CSSProperties = { padding: '3px 6px', background: 'var(--bg-elevated)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: '0.78rem' }
const inp: React.CSSProperties = { flex: 1, padding: '4px 8px', background: 'var(--bg-elevated)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: '0.8rem', outline: 'none' }
const btn = (primary: boolean): React.CSSProperties => ({
  padding: '3px 10px', borderRadius: 'var(--radius)', fontSize: '0.75rem', cursor: 'pointer',
  border: primary ? 'none' : '1px solid var(--border)', background: primary ? 'var(--accent)' : 'transparent', color: primary ? '#fff' : 'var(--text-muted)',
})
const lineStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderBottom: '1px solid var(--border)', fontSize: '0.8rem' }

export const PERMISSION_NAMES: Record<string, string> = {
  read: 'Lecture', write: 'Écriture', admin: 'Administration', none: 'Aucun accès',
}

function sourceName(source: string): string {
  if (source === 'owner') return 'propriétaire du vault'
  if (source === 'vault') return 'vault'
  if (source.startsWith('folder:')) return `dossier « ${source.slice(7)} »`
  return source
}

export function AclTab({ sharing, vaultId, target, token, parentName }: {
  sharing: IVaultSharing
  vaultId: string
  target: AppAclTarget
  token: string
  /** Ce dont ce niveau herite (« dossier Projets », « vault »), pour le texte. */
  parentName: string
}) {
  const [view, setView] = useState<AppAclView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [email, setEmail] = useState('')
  const [found, setFound] = useState<AppUserLookup | null>(null)
  const [permission, setPermission] = useState('read')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const key = `${target.docId ?? ''}|${target.folder ?? ''}`

  const reload = useCallback(async () => {
    if (!sharing.getAcl) return
    try { setView(await sharing.getAcl(vaultId, target, token)); setError(null) }
    catch (e) { setError(String(e).includes('403') ? 'Gérer les droits est réservé aux administrateurs du vault.' : `Droits illisibles (${String(e)}).`) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharing, vaultId, key, token])
  useEffect(() => { setView(null); void reload() }, [reload])

  const run = async (job: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await job(); await reload() } catch (e) { setError(String(e)) }
    setBusy(false)
  }

  function onEmail(value: string) {
    setEmail(value); setFound(null)
    if (timer.current) clearTimeout(timer.current)
    if (!value.includes('@')) return
    timer.current = setTimeout(() => {
      void sharing.lookupUserByEmail(value.trim(), token).then(u => setFound(u), () => setFound(null))
    }, 400)
  }

  if (!sharing.getAcl) return <div style={small}>Ce vault n’a pas de droits par dossier.</div>
  if (error && !view) return <div data-testid="acl-error" style={{ color: 'var(--color-danger)', fontSize: '0.78rem' }}>{error}</div>
  if (!view) return <div style={small}>…</div>

  const explicit = new Set(view.entries.map(e => e.subjectId))
  return (
    <div data-testid="acl-tab" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {error && <div style={{ color: 'var(--color-danger)', fontSize: '0.78rem' }}>{error}</div>}

      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: '0.8rem', cursor: 'pointer' }}>
        <input type="checkbox" data-testid="acl-inherit" checked={view.inherit} disabled={busy}
          onChange={e => void run(() => sharing.setAclInherit!(vaultId, target, e.target.checked, token))} />
        <span>
          Hériter des droits du {parentName}
          <div style={small}>
            {view.inherit
              ? 'Ceux qui ont accès au-dessus ont accès ici, sauf droit différent donné ci-dessous.'
              : 'Seuls les droits donnés ici valent (et le propriétaire, les administrateurs du vault).'}
          </div>
        </span>
      </label>

      <div>
        <div style={{ ...label, marginBottom: 6 }}>Donner un droit ici</div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input data-testid="acl-email" style={inp} type="email" placeholder="Adresse de la personne" value={email} autoComplete="off" onChange={e => onEmail(e.target.value)} />
          <select data-testid="acl-permission" style={sel} value={permission} onChange={e => setPermission(e.target.value)}>
            {Object.entries(PERMISSION_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <button data-testid="acl-add" style={btn(true)} disabled={busy || !found}
            onClick={() => found && void run(async () => { await sharing.setAclEntry!(vaultId, target, found.id, permission, token); setEmail(''); setFound(null) })}>
            Donner
          </button>
        </div>
        {found && <div style={{ fontSize: '0.72rem', color: 'var(--color-success)', marginTop: 4 }}>✓ {found.displayName}</div>}
      </div>

      <div>
        <div style={{ ...label, marginBottom: 4 }}>Droits donnés ici</div>
        {view.entries.length === 0 && <div style={small}>Aucun : tout est hérité.</div>}
        {view.entries.map(e => (
          <div key={e.subjectId} data-testid="acl-entry" data-subject={e.subjectId} data-permission={e.permission} style={lineStyle}>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.displayName ?? e.subjectId}</span>
            <select style={sel} value={e.permission} disabled={busy}
              onChange={ev => void run(() => sharing.setAclEntry!(vaultId, target, e.subjectId, ev.target.value, token))}>
              {Object.entries(PERMISSION_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <button data-testid="acl-remove" style={btn(false)} disabled={busy}
              onClick={() => void run(() => sharing.removeAclEntry!(vaultId, target, e.subjectId, token))}>
              Retirer
            </button>
          </div>
        ))}
      </div>

      <div>
        <div style={{ ...label, marginBottom: 4 }}>Hérité</div>
        {!view.inherit && <div style={{ ...small, marginBottom: 4 }}>Coupé : ces droits ne valent plus ici (sauf propriétaire et administrateurs).</div>}
        {view.inherited.map(i => (
          <div key={i.subjectId} data-testid="acl-inherited" data-subject={i.subjectId} data-permission={i.permission}
            style={{ ...lineStyle, opacity: !view.inherit || explicit.has(i.subjectId) ? 0.5 : 1 }}>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.displayName ?? i.subjectId}</span>
            <span style={small}>{PERMISSION_NAMES[i.permission] ?? i.permission} · {sourceName(i.source)}{explicit.has(i.subjectId) ? ' · remplacé ici' : ''}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
