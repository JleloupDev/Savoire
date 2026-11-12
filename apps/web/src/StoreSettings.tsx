// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Onglet « Store » des parametres : le Savoire Store. Chercher, voir les
// droits demandes, installer ; les plugins installes, desinstaller.
import { useEffect, useState } from 'react'
import { permissionLabel, type SavoireStoreService, type StoreItem, type StoreItemDetail } from './savoireStore'

const KINDS: Record<string, string> = { plugin: 'Plugin', template: 'Modèle de note', module: 'Module' }

const small: React.CSSProperties = { color: 'var(--text-faint)', fontSize: '0.75rem' }
const row: React.CSSProperties = { padding: '10px 14px', borderRadius: 8, background: 'var(--bg-surface)', border: '1px solid var(--border)' }
const section: React.CSSProperties = { fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-faint)', marginTop: 6 }
const button = (primary: boolean): React.CSSProperties => ({
  fontSize: '0.72rem', padding: '3px 10px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border)',
  background: primary ? 'var(--accent)' : 'transparent', color: primary ? 'white' : 'var(--text-muted)', fontWeight: 600, whiteSpace: 'nowrap',
})
const tag: React.CSSProperties = { fontSize: '0.7rem', padding: '1px 7px', borderRadius: 10, background: 'var(--bg-elevated)', color: 'var(--text-muted)', fontWeight: 600, whiteSpace: 'nowrap' }

export function StoreSettings({ store }: { store: SavoireStoreService }) {
  const [installed, setInstalled] = useState(() => store.installed())
  const [q, setQ] = useState('')
  const [kind, setKind] = useState('')
  const [items, setItems] = useState<StoreItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  // Element dont on montre les droits avant d'installer.
  const [confirming, setConfirming] = useState<StoreItemDetail | null>(null)
  const [done, setDone] = useState<string | null>(null)

  useEffect(() => store.onChange(() => setInstalled(store.installed())), [store])

  async function search() {
    setError(null)
    try { setItems(await store.search(q, kind || undefined)) } catch (err) { setError(err instanceof Error ? err.message : String(err)); setItems([]) }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void search() }, [kind])

  async function ask(item: StoreItem) {
    setError(null); setDone(null)
    try { setConfirming(await store.detail(item.id)) } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }

  async function install(id: string) {
    setBusy(id); setError(null); setDone(null)
    try {
      const r = await store.install(id)
      setConfirming(null)
      setDone(r.path ? `Ajouté au vault : ${r.path}` : 'Plugin installé.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  async function uninstall(id: string) {
    setBusy(id); setError(null)
    try { await store.uninstall(id) } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(null) }
  }

  return (
    <div data-testid="store-settings" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={small}>
        Plugins, modèles de notes et modules publiés sur le Savoire Store. Chaque paquet est signé par le store et vérifié avant
        l’installation. Le code d’un plugin tourne à part, isolé de Savoire : il ne fait que ce que ses droits permettent.
      </div>
      {error && <div data-testid="store-error" style={{ color: 'var(--danger, #ef4444)', fontSize: '0.75rem' }}>{error}</div>}
      {done && <div data-testid="store-done" style={{ color: 'var(--green, #16a34a)', fontSize: '0.75rem' }}>{done}</div>}

      <div style={section}>Installés</div>
      {installed.length === 0 && <div style={small}>Aucun plugin du store.</div>}
      {installed.map(p => (
        <div key={p.id} data-testid="store-installed-row" data-item-id={p.id} data-state={p.state} style={row}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{p.name}</div>
              <div style={small}>
                {p.state === 'running' ? 'En marche' : p.state === 'failed' ? `En échec : ${p.error ?? ''}` : 'Arrêté'}
                {p.permissions.length > 0 && ` · ${p.permissions.map(permissionLabel).join(', ')}`}
              </div>
            </div>
            <span style={tag}>v{p.version}</span>
            <button data-testid="store-uninstall" disabled={busy === p.id} style={button(false)} onClick={() => void uninstall(p.id)}>Désinstaller</button>
          </div>
        </div>
      ))}

      <div style={section}>Catalogue</div>
      <form onSubmit={e => { e.preventDefault(); void search() }} style={{ display: 'flex', gap: 6 }}>
        <input data-testid="store-search" value={q} onChange={e => setQ(e.target.value)} placeholder="Chercher sur le store…"
          style={{ flex: 1, padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-base)', color: 'var(--text)' }} />
        <select data-testid="store-kind" value={kind} onChange={e => setKind(e.target.value)}
          style={{ padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-base)', color: 'var(--text)' }}>
          <option value="">Tout</option>
          {Object.entries(KINDS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
        <button type="submit" style={button(true)}>Chercher</button>
      </form>
      {items === null && <div style={small}>Chargement…</div>}
      {items?.length === 0 && !error && <div style={small}>Rien trouvé.</div>}
      {items?.map(item => {
        const isConfirming = confirming?.item.id === item.id
        const isInstalled = item.kind === 'plugin' && store.isInstalled(item.id)
        return (
          <div key={item.id} data-testid="store-item" data-item-id={item.id} data-kind={item.kind} style={row}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{item.name}</div>
                <div style={small}>{item.summary}</div>
                <div style={small}>
                  {item.author} · {item.rating === null ? 'pas encore d’avis' : `${item.rating.toFixed(1)} ★ (${item.ratingCount})`} · {item.downloads} installation(s)
                  {' · '}<a href={`${store.baseUrl}/items/${encodeURIComponent(item.id)}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>page du store</a>
                </div>
              </div>
              <span style={tag}>{KINDS[item.kind] ?? item.kind}</span>
              {item.latestVersion && <span style={tag}>v{item.latestVersion}</span>}
              {item.price
                ? <span style={tag}>{(item.price.cents / 100).toFixed(2)} {item.price.currency} (bientôt)</span>
                : isInstalled
                  ? <span style={tag}>Installé</span>
                  : <button data-testid="store-install" disabled={busy === item.id} style={button(true)} onClick={() => void ask(item)}>
                      {item.kind === 'plugin' ? 'Installer' : 'Ajouter au vault'}
                    </button>}
            </div>
            {isConfirming && confirming && (
              <div data-testid="store-confirm" style={{ marginTop: 10, padding: '8px 10px', borderRadius: 6, background: 'rgba(234,179,8,0.10)', border: '1px solid rgba(234,179,8,0.35)', fontSize: '0.75rem' }}>
                {item.kind === 'plugin' ? (
                  <>
                    <div style={{ marginBottom: 6 }}>
                      {confirming.permissions.length === 0 ? 'Ce plugin ne demande aucun droit.' : 'Ce plugin demande :'}
                    </div>
                    {confirming.permissions.length > 0 && (
                      <ul style={{ margin: '0 0 8px 18px', padding: 0 }}>
                        {confirming.permissions.map(p => <li key={p} data-testid="store-permission">{permissionLabel(p)}</li>)}
                      </ul>
                    )}
                    <div style={{ ...small, marginBottom: 8 }}>
                      Code source : github.com/{confirming.repo}{confirming.license ? ` · licence ${confirming.license}` : ''}. Le plugin est installé pour vous, dans ce navigateur.
                    </div>
                  </>
                ) : (
                  <div style={{ marginBottom: 8 }}>Une note sera ajoutée au vault ouvert.</div>
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button data-testid="store-confirm-install" disabled={busy === item.id} style={button(true)} onClick={() => void install(item.id)}>
                    {busy === item.id ? 'Installation…' : 'Confirmer'}
                  </button>
                  <button style={button(false)} onClick={() => setConfirming(null)}>Annuler</button>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
