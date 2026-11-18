// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// GraphWidget — graphe des liens entre notes.
//
// React ne tient que la barre d'outils et les reglages. Le dessin, la
// camera et les gestes sont dans GraphCanvas (un <canvas>), la mise en
// place dans simulation.ts (Barnes-Hut), les filtres dans graphModel.ts.
// Aucune dependance externe.

import { useState, useEffect, useRef, useCallback, useMemo, type CSSProperties, type ReactNode } from 'react'
import type { IIndexerAPI, ViewContext, WorkspaceAPI, VaultAPI, Widget } from '@savoire/plugin-api'
import type { GraphIndexContributor, GraphNode, GraphEdge } from './GraphIndexContributor'
import { GraphCanvas, type DisplayOptions } from './GraphCanvas'
import { buildModel, selectView, DEFAULT_SETTINGS, type GraphModel, type GraphSettings, type ModelNode } from './graphModel'
import { DEFAULT_FORCES } from './simulation'

/** Notes au plus quand le graphe vient de l'index complet (les plus reliees d'abord). */
export const GRAPH_REMOTE_LIMIT = 2_000
/** Le pair indexe une modification une a deux secondes apres : on relit alors. */
const PEER_DELAY_MS = 1_500
/** Les notes ouvertes se re-indexent a chaque frappe : on regroupe. */
const LOCAL_DELAY_MS = 300

const SETTINGS_KEY = 'savoire.graph.settings.v1'

function loadSettings(): GraphSettings {
  try {
    const raw = globalThis.localStorage?.getItem(SETTINGS_KEY)
    if (raw) {
      const s = JSON.parse(raw) as Partial<GraphSettings>
      return { ...DEFAULT_SETTINGS, ...s, search: '', forces: { ...DEFAULT_FORCES, ...s.forces } }
    }
  } catch { /* reglages illisibles : ceux par defaut */ }
  return { ...DEFAULT_SETTINGS, forces: { ...DEFAULT_FORCES } }
}

function saveSettings(s: GraphSettings): void {
  try {
    const { search: _search, ...rest } = s
    globalThis.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(rest))
  } catch { /* stockage plein ou interdit : tant pis */ }
}

// ── Component ─────────────────────────────────────────────────────────────────

function GraphPanel({ getContributor, workspace, vault, indexer }: {
  getContributor: () => GraphIndexContributor
  workspace: WorkspaceAPI
  vault: VaultAPI
  /** Index de tout le vault (pouvoir links.graph) : toutes les notes, ouvertes ou non. */
  indexer?: IIndexerAPI
}) {
  const [settings, setSettings] = useState<GraphSettings>(loadSettings)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const update = useCallback((patch: Partial<GraphSettings>) => {
    setSettings(s => { const next = { ...s, ...patch }; saveSettings(next); return next })
  }, [])

  const [activePath, setActivePath] = useState<string | null>(
    () => workspace.getActiveDocument()?.path ?? null,
  )
  const activeRef = useRef(activePath)
  activeRef.current = activePath

  const [counts, setCounts] = useState({ nodes: 0, links: 0, total: 0 })
  const [folders, setFolders] = useState<Array<{ folder: string; color: string; count: number }>>([])
  const [showSettings, setShowSettings] = useState(false)
  const [whole, setWhole] = useState(false)

  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<GraphCanvas | null>(null)
  const modelRef = useRef<GraphModel | null>(null)
  const visibleRef = useRef<ModelNode[]>([])

  // ── Canvas ────────────────────────────────────────────────────────────────

  const display: DisplayOptions = useMemo(() => ({
    showArrows: settings.showArrows,
    colorByFolder: settings.colorByFolder,
    labelZoom: settings.labelZoom,
    nodeSize: settings.nodeSize,
    linkWidth: settings.linkWidth,
  }), [settings.showArrows, settings.colorByFolder, settings.labelZoom, settings.nodeSize, settings.linkWidth])
  const displayRef = useRef(display)
  displayRef.current = display

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const canvas = new GraphCanvas(host, displayRef.current, {
      onOpen: node => { void workspace.openFile(node.path) },
    })
    canvas.setForces(settingsRef.current.forces)
    canvasRef.current = canvas
    return () => { canvas.destroy(); canvasRef.current = null }
  }, [workspace])

  useEffect(() => { canvasRef.current?.setDisplay(display) }, [display])
  useEffect(() => { canvasRef.current?.setForces(settings.forces) }, [settings.forces])

  /** Applique filtres et mode au modele, et le donne au canvas. */
  const applyView = useCallback((opts: { fresh: boolean; refit: boolean }) => {
    const model = modelRef.current
    if (!model) return
    const view = selectView(model, settingsRef.current, activeRef.current)
    visibleRef.current = view.nodes
    setCounts({ nodes: view.nodes.length, links: view.links.length, total: model.nodes.length })
    const byFolder = new Map<string, { folder: string; color: string; count: number }>()
    for (const n of view.nodes) {
      if (!n.color || n.attachment) continue
      const f = byFolder.get(n.folder)
      if (f) f.count++
      else byFolder.set(n.folder, { folder: n.folder, color: n.color, count: 1 })
    }
    setFolders([...byFolder.values()].sort((a, b) => b.count - a.count))
    canvasRef.current?.setView(view, opts)
    canvasRef.current?.setActive(activeRef.current)
  }, [])

  const setGraph = useCallback((nodes: GraphNode[], edges: GraphEdge[]) => {
    const prev = modelRef.current
    modelRef.current = buildModel(nodes, edges, prev ?? undefined)
    applyView({ fresh: !prev || prev.nodes.length === 0, refit: false })
  }, [applyView])

  // ── Donnees ───────────────────────────────────────────────────────────────

  // Le graphe montre TOUT le vault, pas seulement ce qui a ete indexe.
  // L'index ne connait que les documents ouverts ou re-indexes : s'y limiter
  // faisait disparaitre les notes jamais ouvertes, et avec elles toutes les
  // aretes qui pointaient vers elles. Les noeuds viennent donc du repertoire
  // du vault, l'index n'apportant que les liens.
  const vaultNodesRef = useRef<GraphNode[]>([])
  // Graphe rendu par l'index complet (links.graph), quand il repond.
  const remoteRef = useRef<{ nodes: GraphNode[]; edges: GraphEdge[] } | null>(null)

  const rebuild = useCallback(() => {
    const remote = remoteRef.current
    if (remote) { setGraph(remote.nodes, remote.edges); return }
    // Un document mis a la corbeille garde ses entrees d'index (une
    // restauration le fait revenir tel quel) : on le masque ici.
    const trashed = (id: string) => vault.isTrashed?.(id) ?? false
    const indexed = getContributor().getNodes().filter(n => !trashed(n.docId))
    // Fusion par CHEMIN, pas par docId : le repertoire du vault et l'index ne
    // s'accordent pas toujours sur l'identifiant d'une note (resolveDocumentId
    // peut echouer et retomber sur le chemin), et fusionner par docId
    // dedoublait alors les noeuds. Le chemin, lui, identifie la note de facon
    // stable. L'entree de l'index gagne : elle porte le docId reel, celui
    // auquel les aretes font reference.
    const key = (path: string) => path.replace(/\.md$/i, '').toLowerCase()
    const merged = new Map<string, GraphNode>()
    for (const n of vaultNodesRef.current) merged.set(key(n.path), n)
    for (const n of indexed) merged.set(key(n.path), n)
    const edges = getContributor().getAllEdges().filter(e => !trashed(e.sourceId))
    setGraph([...merged.values()], edges)
  }, [getContributor, vault, setGraph])

  const reloadVaultNodes = useCallback(async () => {
    try {
      const paths = await vault.list()
      vaultNodesRef.current = paths
        .filter(p => !p.endsWith('/'))
        .map(p => ({ docId: vault.resolveDocumentId(p) ?? p, path: p }))
    } catch (err) {
      console.warn('[graph] liste du vault indisponible', err)
      vaultNodesRef.current = []
    }
    rebuild()
  }, [vault, rebuild])

  // Index complet : le graphe de tout le vault, d'un seul appel. Refus ou
  // index absent : le graphe local (notes indexees + arborescence).
  const request = useRef(0)
  const loadRemote = useCallback(() => {
    const n = ++request.current
    if (!indexer?.available()) {
      if (remoteRef.current) { remoteRef.current = null; setWhole(false); void reloadVaultNodes() }
      return
    }
    indexer.links.graph({ limit: GRAPH_REMOTE_LIMIT }).then(g => {
      if (n !== request.current) return
      remoteRef.current = {
        nodes: g.nodes.map(x => ({ docId: x.id, path: x.path })),
        // Les aretes de l'index designent des ids : buildModel les trouve par id.
        edges: g.edges.map(e => ({ sourceId: e.from, targetPath: e.to, linkType: 'wikilink' as const })),
      }
      setWhole(true)
      rebuild()
    }, () => {
      if (n !== request.current) return
      remoteRef.current = null
      setWhole(false)
      void reloadVaultNodes()
    })
  }, [indexer, rebuild, reloadVaultNodes])

  useEffect(() => {
    void reloadVaultNodes()
    loadRemote()
    let later: ReturnType<typeof setTimeout> | null = null
    const unsubIndexed = workspace.subscribeDocumentIndexed?.(() => {
      if (later) clearTimeout(later)
      later = setTimeout(remoteRef.current ? loadRemote : rebuild, remoteRef.current ? PEER_DELAY_MS : LOCAL_DELAY_MS)
    })
    // Creation, renommage, suppression d'une note : la liste change sans
    // qu'aucune indexation ne se produise.
    const unsubVault = workspace.subscribeVaultChange?.(() => { void reloadVaultNodes(); loadRemote() })
    const unsubState = indexer?.onStateChange(() => loadRemote())
    return () => { unsubIndexed?.(); unsubVault?.(); unsubState?.(); if (later) clearTimeout(later) }
  }, [workspace, rebuild, reloadVaultNodes, loadRemote, indexer])

  // Note active : anneau, et centre du graphe local.
  useEffect(() => {
    const unsub = workspace.subscribeActiveDocument?.((path) => setActivePath(path))
    return unsub
  }, [workspace])

  useEffect(() => {
    if (settingsRef.current.mode === 'local') applyView({ fresh: false, refit: true })
    else canvasRef.current?.setActive(activePath)
  }, [activePath, applyView])

  // Filtres : on refait la vue et on recadre.
  const filterKey = `${settings.mode}|${settings.depth}|${settings.search}|${settings.showOrphans}|${settings.showAttachments}`
  const firstFilter = useRef(true)
  useEffect(() => {
    if (firstFilter.current) { firstFilter.current = false; return }
    applyView({ fresh: false, refit: true })
  }, [filterKey, applyView])

  const focusFirstMatch = () => {
    const q = settings.search.trim().toLowerCase()
    const hit = visibleRef.current.find(n => n.label.toLowerCase().startsWith(q)) ?? visibleRef.current[0]
    if (hit) canvasRef.current?.focus(hit)
  }

  // ── Rendu ─────────────────────────────────────────────────────────────────

  const local = settings.mode === 'local'
  const empty = counts.total === 0
  const btn: CSSProperties = {
    border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-muted)',
    borderRadius: 'var(--radius, 4px)', padding: '2px 8px', fontSize: '0.72rem', cursor: 'pointer', lineHeight: 1.6,
  }
  const on: CSSProperties = { ...btn, background: 'var(--accent-dim)', color: 'var(--accent)', border: '1px solid var(--accent)' }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg-base)' }}>
      {/* Barre */}
      <div style={{ padding: '5px 10px', borderBottom: '1px solid var(--border)', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.65rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-muted)' }}>
          Graphe — {counts.nodes} notes · {counts.links} liens
        </span>
        <span
          data-testid="graph-source"
          data-whole={whole ? 'true' : 'false'}
          title={whole ? `Toutes les notes du vault, ouvertes ou non (${GRAPH_REMOTE_LIMIT} au plus, les plus reliées d'abord).` : 'Liens des notes déjà indexées (ouvertes quelque part).'}
          style={{ fontSize: '0.62rem', color: 'var(--text-faint)' }}
        >
          {whole ? 'tout le vault' : 'notes indexées'}
        </span>
        <span style={{ flex: 1 }} />
        <div role="group" aria-label="Portée" style={{ display: 'flex', gap: 2 }}>
          <button type="button" style={local ? btn : on} aria-pressed={!local} onClick={() => update({ mode: 'global' })}
            title="Toutes les notes">Global</button>
          <button type="button" style={local ? on : btn} aria-pressed={local} onClick={() => update({ mode: 'local' })}
            title="La note ouverte et ses voisines">Local</button>
        </div>
        {local && (
          <label style={{ fontSize: '0.72rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}
            title="Nombre de liens à suivre depuis la note ouverte">
            Profondeur
            <select value={settings.depth} onChange={e => update({ depth: Number(e.target.value) })}
              style={{ fontSize: '0.72rem', background: 'var(--bg-surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4 }}>
              {[1, 2, 3, 4, 5].map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>
        )}
        <input
          type="search"
          placeholder="Filtrer les notes…"
          aria-label="Filtrer les notes"
          value={settings.search}
          onChange={e => update({ search: e.target.value })}
          onKeyDown={e => { if (e.key === 'Enter') focusFirstMatch(); if (e.key === 'Escape') update({ search: '' }) }}
          style={{ width: 170, fontSize: '0.75rem', padding: '3px 8px', background: 'var(--bg-surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 'var(--radius, 4px)' }}
        />
        <button type="button" style={showSettings ? on : btn} aria-pressed={showSettings} onClick={() => setShowSettings(v => !v)}
          title="Réglages du graphe">Réglages</button>
      </div>

      {/* Dessin */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden', minHeight: 0 }}>
        <div ref={hostRef} style={{ position: 'absolute', inset: 0, cursor: 'grab' }} />

        {empty && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.78rem', color: 'var(--text-muted)', fontStyle: 'italic', pointerEvents: 'none' }}>
            Ce vault ne contient aucune note.
          </div>
        )}
        {!empty && counts.nodes === 0 && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.78rem', color: 'var(--text-muted)', fontStyle: 'italic', pointerEvents: 'none' }}>
            {local ? 'Ouvrez une note pour voir ses voisines.' : 'Aucune note ne correspond au filtre.'}
          </div>
        )}

        {/* Zoom */}
        <div style={{ position: 'absolute', right: 10, bottom: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <button type="button" style={btn} title="Zoomer (+)" aria-label="Zoomer" onClick={() => canvasRef.current?.zoomBy(1.3)}>+</button>
          <button type="button" style={btn} title="Dézoomer (−)" aria-label="Dézoomer" onClick={() => canvasRef.current?.zoomBy(1 / 1.3)}>−</button>
          <button type="button" style={btn} title="Tout voir (0, ou double-clic sur le fond)" aria-label="Tout voir" onClick={() => canvasRef.current?.fit(true)}>⤢</button>
          <button type="button" style={btn} title="Relancer la mise en place" aria-label="Réorganiser" onClick={() => canvasRef.current?.reheat()}>↻</button>
        </div>

        {/* Legende des dossiers */}
        {settings.colorByFolder && folders.length > 0 && (
          <div style={{ position: 'absolute', left: 10, bottom: 10, display: 'flex', flexDirection: 'column', gap: 2, fontSize: '0.68rem', color: 'var(--text-muted)', background: 'var(--bg-base)', opacity: 0.9, padding: '4px 6px', borderRadius: 6, pointerEvents: 'none', maxWidth: 220 }}>
            {folders.map(f => (
              <span key={f.folder} style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: f.color, flexShrink: 0 }} />
                {f.folder} <span style={{ color: 'var(--text-faint)' }}>{f.count}</span>
              </span>
            ))}
          </div>
        )}

        {showSettings && (
          <SettingsPanel settings={settings} update={update} onClose={() => setShowSettings(false)} />
        )}
      </div>
    </div>
  )
}

// ── Reglages ──────────────────────────────────────────────────────────────────

function SettingsPanel({ settings: s, update, onClose }: {
  settings: GraphSettings
  update: (patch: Partial<GraphSettings>) => void
  onClose: () => void
}) {
  const forces = (patch: Partial<GraphSettings['forces']>) => update({ forces: { ...s.forces, ...patch } })
  return (
    <div
      role="dialog"
      aria-label="Réglages du graphe"
      style={{
        position: 'absolute', top: 10, right: 10, width: 250, maxHeight: 'calc(100% - 20px)', overflowY: 'auto',
        background: 'var(--bg-elevated, var(--bg-surface))', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg, 8px)',
        boxShadow: 'var(--shadow-md)', padding: '8px 12px 12px', fontSize: '0.75rem', color: 'var(--text)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
        <strong style={{ flex: 1 }}>Réglages</strong>
        <button type="button" onClick={onClose} aria-label="Fermer" style={{ border: 'none', background: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.9rem' }}>×</button>
      </div>

      <Section title="Filtres">
        <Check label="Notes sans lien" checked={s.showOrphans} onChange={v => update({ showOrphans: v })} />
        <Check label="Pièces jointes (images, PDF…)" checked={s.showAttachments} onChange={v => update({ showAttachments: v })} />
      </Section>

      <Section title="Affichage">
        <Check label="Couleur par dossier" checked={s.colorByFolder} onChange={v => update({ colorByFolder: v })} />
        <Check label="Flèches" checked={s.showArrows} onChange={v => update({ showArrows: v })} />
        <Slider label="Apparition des noms" min={0.2} max={3} step={0.05} value={s.labelZoom} onChange={v => update({ labelZoom: v })}
          hint="Plus bas : les noms apparaissent de plus loin." />
        <Slider label="Taille des notes" min={0.4} max={3} step={0.1} value={s.nodeSize} onChange={v => update({ nodeSize: v })} />
        <Slider label="Épaisseur des liens" min={0.3} max={4} step={0.1} value={s.linkWidth} onChange={v => update({ linkWidth: v })} />
      </Section>

      <Section title="Forces">
        <Slider label="Rappel au centre" min={0} max={0.3} step={0.005} value={s.forces.center} onChange={v => forces({ center: v })} />
        <Slider label="Répulsion" min={10} max={1000} step={10} value={s.forces.repulsion} onChange={v => forces({ repulsion: v })} />
        <Slider label="Force des liens" min={0} max={2} step={0.05} value={s.forces.linkStrength} onChange={v => forces({ linkStrength: v })} />
        <Slider label="Longueur des liens" min={10} max={300} step={5} value={s.forces.linkDistance} onChange={v => forces({ linkDistance: v })} />
      </Section>

      <button
        type="button"
        onClick={() => update({ ...DEFAULT_SETTINGS, mode: s.mode, depth: s.depth, search: s.search, forces: { ...DEFAULT_FORCES } })}
        style={{ marginTop: 8, fontSize: '0.72rem', border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-muted)', borderRadius: 4, padding: '2px 8px', cursor: 'pointer' }}
      >
        Valeurs par défaut
      </button>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '6px 0 0', padding: '6px 0 0' }}>
      <legend style={{ fontSize: '0.62rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-faint)', padding: '0 4px 0 0' }}>{title}</legend>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{children}</div>
    </fieldset>
  )
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
      {label}
    </label>
  )
}

function Slider({ label, min, max, step, value, onChange, hint }: {
  label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void; hint?: string
}) {
  return (
    <label title={hint} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} style={{ width: '100%', accentColor: 'var(--accent)' }} />
    </label>
  )
}

// ── Widget wrapper ─────────────────────────────────────────────────────────────

export class GraphWidget implements Widget {
  constructor(
    private readonly ctx: ViewContext,
    private readonly getContributor: () => GraphIndexContributor,
    private readonly indexer?: IIndexerAPI,
  ) {}

  render() {
    return <GraphPanel getContributor={this.getContributor} workspace={this.ctx.workspace} vault={this.ctx.vault} indexer={this.indexer} />
  }

  dispose(): void {}
}
