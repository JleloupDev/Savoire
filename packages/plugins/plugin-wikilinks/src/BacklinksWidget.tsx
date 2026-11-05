// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Retroliens de la note active. Avec un index de tout le vault (api.indexer,
// pouvoir links.backlinks : pair indexeur ou index local complet), les notes
// jamais ouvertes ici comptent aussi ; sinon, l'index partage des wikilinks
// (notes deja indexees quelque part). Voir ADR-027.
import { useState, useEffect, useCallback, useRef } from 'react'
import type { IIndexerAPI, ViewContext, Widget } from '@savoire/plugin-api'
import type { WikilinkIndexContributor, BacklinkEntry } from './WikilinkIndexContributor'
import { allFilePaths } from './vaultFiles'

/** Le pair indexe une modification une a deux secondes apres : on relit alors. */
const PEER_DELAY_MS = 1_500

interface Backlink extends BacklinkEntry {
  /** Nombre de liens (index complet seulement). */
  count?: number
}

function BacklinksPanel({
  ctx,
  contributor,
  indexer,
}: {
  ctx: ViewContext
  contributor: WikilinkIndexContributor
  indexer?: IIndexerAPI
}) {
  const { workspace } = ctx

  const [currentPath, setCurrentPath] = useState<string | null>(
    () => workspace.getActiveDocument()?.path ?? null
  )
  const [backlinks, setBacklinks] = useState<Backlink[]>([])
  const [whole, setWhole] = useState(false)
  const request = useRef(0)
  const later = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback((path: string | null) => {
    const n = ++request.current
    if (!path) { setBacklinks([]); setWhole(false); return }
    const local = () => {
      // Les liens se resolvent contre tous les fichiers du vault (noms ambigus).
      void allFilePaths(ctx.vault).catch(() => undefined).then(paths => {
        if (n !== request.current) return
        setWhole(false)
        setBacklinks(contributor.getBacklinks(path, paths).filter(bl => !ctx.vault.isTrashed?.(bl.docId)))
      })
    }
    const id = indexer?.available() ? ctx.vault.resolveDocumentId(path) : undefined
    if (!indexer || !id) { local(); return }
    indexer.links.backlinks({ id }).then(r => {
      if (n !== request.current) return
      setWhole(true)
      setBacklinks(r.items.map(i => ({ docId: i.id, path: i.path, count: i.count })))
    }, () => local())
  }, [contributor, ctx, indexer])

  useEffect(() => { refresh(currentPath) }, [currentPath, refresh])

  useEffect(() => {
    const unsub = workspace.subscribeActiveDocument?.((path) => { setCurrentPath(path) })
    return unsub
  }, [workspace])

  // Index complet qui apparait, tombe ou revient : on relit.
  useEffect(() => indexer?.onStateChange(() => refresh(currentPath)), [indexer, currentPath, refresh])

  // Une note indexee ici : l'index local a change tout de suite, le pair un peu apres.
  useEffect(() => {
    const unsubIndexed = workspace.subscribeDocumentIndexed?.(() => {
      if (!indexer?.available()) { refresh(currentPath); return }
      if (later.current) clearTimeout(later.current)
      later.current = setTimeout(() => refresh(currentPath), PEER_DELAY_MS)
    })
    const unsubVault = workspace.subscribeVaultChange?.(() => refresh(currentPath))
    return () => {
      unsubIndexed?.()
      unsubVault?.()
      if (later.current) clearTimeout(later.current)
    }
  }, [workspace, indexer, currentPath, refresh])

  const T = {
    panel:   { height: '100%', display: 'flex', flexDirection: 'column' as const, fontFamily: 'inherit', color: 'inherit', fontSize: 13 },
    header:  { padding: '8px 10px 4px', borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 },
    title:   { fontWeight: 600, fontSize: '0.7rem', textTransform: 'uppercase' as const, letterSpacing: '0.08em', color: 'var(--text-faint, #888)', marginBottom: 4 },
    docName: { fontSize: '0.78rem', color: 'var(--text, #cdd6f4)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
    body:    { flex: 1, overflow: 'auto', padding: '4px 0' },
    empty:   { padding: '12px 10px', fontSize: '0.75rem', color: 'var(--text-faint, #888)', fontStyle: 'italic' as const },
    item:    { padding: '5px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, borderRadius: 4, margin: '0 4px' } as React.CSSProperties,
    badge:   { fontSize: '0.6rem', padding: '1px 5px', borderRadius: 4, background: 'rgba(255,255,255,0.07)', color: 'var(--text-faint, #888)', flexShrink: 0 } as React.CSSProperties,
    source:  { fontSize: '0.62rem', color: 'var(--text-faint, #888)', marginTop: 2 },
  }

  return (
    <div style={T.panel}>
      <div style={T.header}>
        <div style={T.title}>Backlinks</div>
        {currentPath
          ? <div style={T.docName}>{currentPath.split('/').at(-1)}</div>
          : <div style={T.docName}>—</div>
        }
        {currentPath && (
          <div style={T.source} data-testid="backlinks-source" data-whole={whole ? 'true' : 'false'}
            title={whole ? 'Toutes les notes du vault, ouvertes ou non.' : 'Seulement les notes déjà indexées (ouvertes quelque part).'}>
            {whole ? 'Tout le vault' : 'Notes déjà indexées'}
          </div>
        )}
      </div>
      <div style={T.body}>
        {!currentPath && <div style={T.empty}>Ouvrir un document pour voir ses backlinks.</div>}
        {currentPath && backlinks.length === 0 && <div style={T.empty}>Aucun document ne pointe vers celui-ci.</div>}
        {backlinks.map(bl => (
          <div
            key={bl.docId}
            data-testid="backlink"
            style={T.item}
            onClick={() => void workspace.openFile(bl.path)}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.06)' }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
          >
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {bl.path.split('/').at(-1)}
            </span>
            <span style={T.badge}>{bl.count && bl.count > 1 ? `wikilink ×${bl.count}` : 'wikilink'}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export class BacklinksWidget implements Widget {
  constructor(
    private readonly ctx: ViewContext,
    private readonly contributor: WikilinkIndexContributor,
    private readonly indexer?: IIndexerAPI,
  ) {}

  render() {
    return <BacklinksPanel ctx={this.ctx} contributor={this.contributor} indexer={this.indexer} />
  }

  dispose(): void {}
}
