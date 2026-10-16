// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Vue d'une carte mentale : mind-elixir, reliee a l'arbre partage du
// document (ctx.tree). Voir model.ts pour la forme du modele.
//
//  - modification locale : mind-elixir emet une operation ('operation' sur
//    son bus). On ecrit dans l'arbre les seuls noeuds qu'elle touche, sous
//    l'etiquette de cette vue (anti-echo) ;
//  - modification d'un autre membre : on relit le modele et on redessine la
//    carte (refresh), en gardant la selection et le pliage. Pendant
//    l'edition d'un titre, on attend la fin de l'edition : redessiner
//    detruirait la zone de saisie ;
//  - les touches passent toutes au moteur de raccourcis : les raccourcis
//    integres de mind-elixir sont coupes (keypress: false), ses actions sont
//    des commandes `mindmap:*` (voir commands.ts).
import MindElixir from 'mind-elixir'
import type { MindElixirData, MindElixirInstance, NodeObj } from 'mind-elixir'
import type { DocumentRoom, FileContext, ISharedTree, PluginAPI } from '@savoire/plugin-api'
import {
  emptyMap,
  hasNodes,
  materialize,
  parseLegacy,
  readModel,
  requestFor,
  writeAll,
  writeFromView,
  type MindOperation,
} from './model'

const CONTAINER_STYLE = [
  'height:100%', 'width:100%', 'overflow:hidden', 'position:relative',
  'background:var(--bg-base,#1e1e2e)',
].join(';')

/** Operations de mind-elixir gardees par `before` (lecture seule). */
const GUARDED = [
  'reshapeNode', 'insertSibling', 'insertParent', 'addChild', 'copyNode', 'copyNodes',
  'moveUpNode', 'moveDownNode', 'removeNode', 'removeNodes', 'moveNodeIn',
  'moveNodeBefore', 'moveNodeAfter', 'beginEdit', 'setNodeTopic',
] as const

const ARROW_WRITE_MS = 300

const editors = new Set<MindmapEditor>()

/** La carte qui a le focus, s'il y en a une. */
export function focusedMindmap(): MindmapEditor | null {
  const active = typeof document !== 'undefined' ? document.activeElement : null
  if (!active) return null
  for (const ed of editors) if (ed.contains(active)) return ed
  return null
}

export interface MindmapEditorOptions {
  parent: HTMLElement
  /** Arbre partage du document ; absent = lecture seule. */
  tree?: ISharedTree
  /** Titre de la racine d'une carte neuve. */
  title: string
  readOnly?: boolean
  /** Ancien contenu (snapshot JSON), affiche tant que l'arbre est vide. */
  legacy?: MindElixirData | null
  /** Appele une fois l'ancien contenu recopie dans l'arbre. */
  onMigrated?: () => void
  /** Toutes les touches de la carte passent ici (moteur de raccourcis). */
  onKeyDown?: (event: KeyboardEvent) => boolean
}

export class MindmapEditor {
  readonly me: MindElixirInstance
  readonly dom: HTMLElement
  private readonly tree?: ISharedTree
  /** Etiquette des ecritures de CETTE vue. */
  private readonly tag = {}
  private readonly collapsed = new Set<string>()
  private readOnly: boolean
  private legacy: MindElixirData | null = null
  private pendingRemote = false
  private renderQueued = false
  private applying = false
  private destroyed = false
  private readonly arrowTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly cleanups: Array<() => void> = []

  constructor(private readonly opts: MindmapEditorOptions) {
    this.tree = opts.tree
    this.readOnly = !!opts.readOnly || !opts.tree

    opts.parent.replaceChildren()
    opts.parent.style.cssText = CONTAINER_STYLE
    // Mind Elixir a besoin d'un element fils avec une hauteur explicite.
    const el = document.createElement('div')
    el.style.cssText = 'height:100%;width:100%;'
    el.dataset.testid = 'mindmap-view'
    opts.parent.appendChild(el)
    this.dom = el

    const before: Record<string, () => boolean> = {}
    for (const name of GUARDED) before[name] = () => !this.readOnly
    this.me = new MindElixir({
      el,
      direction: MindElixir.RIGHT,
      draggable: true,
      contextMenu: true,
      toolBar: true,
      // Pas de raccourcis integres : le moteur de l'application les porte.
      keypress: false,
      before,
    })

    const initial = this.initialData(opts.legacy ?? null)
    const err = this.me.init(initial)
    if (err) console.error('[plugin-mindmap] init', err)
    if (this.readOnly) this.me.disableEdit()
    // Le conteneur n'a pas toujours sa taille au montage (panneau pas encore
    // dimensionne) : on recentre la premiere fois qu'il en a une.
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        if (this.destroyed || !el.offsetWidth || !el.offsetHeight) return
        ro.disconnect()
        this.me.toCenter()
      })
      ro.observe(el)
      this.cleanups.push(() => ro.disconnect())
    }

    this.listen()
    editors.add(this)
  }

  /** L'element est-il dans cette carte ? */
  contains(node: Node): boolean {
    return this.dom.contains(node)
  }

  isReadOnly(): boolean {
    return this.readOnly
  }

  setReadOnly(readOnly: boolean): void {
    this.readOnly = readOnly || !this.tree
    if (this.readOnly) this.me.disableEdit()
    else this.me.enableEdit()
  }

  /** Ancien contenu connu : affiche tant que l'arbre partage est vide. */
  setLegacy(data: MindElixirData | null): void {
    if (!data || (this.tree && hasNodes(this.tree))) return
    this.legacy = data
    this.refreshView(data)
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    editors.delete(this)
    for (const t of this.arrowTimers.values()) clearTimeout(t)
    for (const c of this.cleanups) c()
    this.me.destroy()
  }

  // ── Interne ────────────────────────────────────────────────────────────

  private initialData(legacy: MindElixirData | null): MindElixirData {
    if (this.tree) {
      const data = materialize(readModel(this.tree), this.collapsed)
      if (data) return data
    }
    if (legacy) {
      this.legacy = legacy
      return legacy
    }
    return emptyMap(this.opts.title)
  }

  private listen(): void {
    const me = this.me
    const onOperation = (op: unknown) => this.onOperation(op as MindOperation)
    const onExpand = (n: NodeObj) => {
      if (n.expanded === false) this.collapsed.add(n.id)
      else this.collapsed.delete(n.id)
    }
    const onArrowDelta = (a: { id: string }) => this.scheduleArrowWrite(a.id)
    me.bus.addListener('operation', onOperation)
    me.bus.addListener('expandNode', onExpand)
    me.bus.addListener('updateArrowDelta', onArrowDelta)
    this.cleanups.push(() => {
      me.bus.removeListener('operation', onOperation)
      me.bus.removeListener('expandNode', onExpand)
      me.bus.removeListener('updateArrowDelta', onArrowDelta)
    })

    // Touches : toutes au moteur. Une saisie de titre arrete la propagation
    // elle-meme : Entree, Tab, Echap y restent a mind-elixir.
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return
      this.opts.onKeyDown?.(e)
    }
    me.map.addEventListener('keydown', onKey)
    this.cleanups.push(() => me.map.removeEventListener('keydown', onKey))

    // Ctrl + molette : zoom (mind-elixir le posait avec ses raccourcis).
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      this.zoom(e.deltaY < 0 ? 1 : -1)
    }
    me.map.addEventListener('wheel', onWheel, { passive: false })
    this.cleanups.push(() => me.map.removeEventListener('wheel', onWheel))

    // Fin d'une edition de titre : appliquer ce qui est arrive entre-temps.
    // 'blur' en capture : la zone de saisie se retire elle-meme sur son blur,
    // un 'focusout' arriverait apres, sur un element deja detache.
    const onBlur = () => setTimeout(() => this.flushPending(), 0)
    me.container.addEventListener('blur', onBlur, true)
    this.cleanups.push(() => me.container.removeEventListener('blur', onBlur, true))

    if (this.tree) {
      const tree = this.tree
      const off = tree.onChange((_changes, info) => {
        if (info.tag === this.tag) return
        this.queueRender()
      })
      this.cleanups.push(off)
    }
  }

  /** Zoom par pas (comme mind-elixir : de 0.6 a 1.6). */
  zoom(step: 1 | -1 | 0): void {
    const me = this.me
    if (step === 0) { me.scale(1); return }
    const next = me.scaleVal + step * me.scaleSensitivity
    if (next > 1.8 || next < 0.4) return
    me.scale(next)
  }

  private onOperation(op: MindOperation): void {
    if (this.applying || this.destroyed || !this.tree || this.readOnly) return
    const tree = this.tree
    const data = this.me.getData()
    if (this.legacy && !hasNodes(tree)) {
      // Premiere modification d'un ancien fichier : on recopie toute la
      // carte (avec cette modification) dans l'arbre partage.
      tree.transact(() => writeAll(tree, data), this.tag)
      this.legacy = null
      this.opts.onMigrated?.()
      return
    }
    this.legacy = null
    const req = requestFor(op, data)
    if (!req) return
    tree.transact(() => writeFromView(tree, data, req), this.tag)
  }

  private scheduleArrowWrite(id: string): void {
    const old = this.arrowTimers.get(id)
    if (old) clearTimeout(old)
    this.arrowTimers.set(id, setTimeout(() => {
      this.arrowTimers.delete(id)
      if (this.destroyed || !this.tree || this.readOnly) return
      const tree = this.tree
      const data = this.me.getData()
      tree.transact(() => writeFromView(tree, data, { arrows: [id] }), this.tag)
    }, ARROW_WRITE_MS))
  }

  private queueRender(): void {
    if (this.renderQueued) return
    this.renderQueued = true
    queueMicrotask(() => {
      this.renderQueued = false
      this.renderFromModel()
    })
  }

  /** Une saisie (titre, etiquette de fleche, resume) est-elle en cours ? */
  private isEditing(): boolean {
    const active = document.activeElement as HTMLElement | null
    return !!active && this.me.container.contains(active) && active !== this.me.map && active.isContentEditable
  }

  private flushPending(): void {
    if (!this.pendingRemote || this.destroyed) return
    this.renderFromModel()
  }

  private renderFromModel(): void {
    if (this.destroyed || !this.tree) return
    const data = materialize(readModel(this.tree), this.collapsed)
    if (!data) return // arbre encore vide : on garde ce qui est affiche
    this.legacy = null
    if (this.isEditing()) {
      this.pendingRemote = true
      return
    }
    this.pendingRemote = false
    if (sameContent(this.me.getData(), data)) return
    this.refreshView(data)
  }

  /** Redessine la carte en gardant la selection quand c'est possible. */
  private refreshView(data: MindElixirData): void {
    const me = this.me
    const selected = me.currentNode?.nodeObj?.id ?? null
    const many = me.currentNodes?.map(n => n.nodeObj.id) ?? null
    this.applying = true
    try {
      me.refresh(data)
    } catch (err) {
      console.warn('[plugin-mindmap] refresh', err)
    } finally {
      this.applying = false
    }
    // Les anciens elements n'existent plus : on retrouve la selection par id
    // (dans CETTE carte : sans instance, findEle cherche dans toute la page),
    // sans faire defiler la carte.
    me.currentNode = null
    me.currentNodes = null
    const find = (id: string) => {
      try { return me.findEle(id, me) } catch { return null }
    }
    if (selected) {
      const el = find(selected)
      if (el) { el.className = 'selected'; me.currentNode = el }
    } else if (many) {
      const els = many.map(find).filter((e): e is NonNullable<typeof e> => !!e)
      if (els.length) {
        for (const e of els) e.className = 'selected'
        me.currentNodes = els
      }
    }
  }
}

/** Meme carte (structure, titres, proprietes, fleches, resumes) ? */
function sameContent(a: MindElixirData, b: MindElixirData): boolean {
  const strip = (n: NodeObj): unknown => {
    const { parent: _p, expanded: _e, children, ...rest } = n
    return { ...rest, children: (children ?? []).map(strip) }
  }
  return JSON.stringify([strip(a.nodeData), a.arrows ?? [], a.summaries ?? []])
    === JSON.stringify([strip(b.nodeData), b.arrows ?? [], b.summaries ?? []])
}

// ── FileView ─────────────────────────────────────────────────────────────

function fileTitle(path: string): string {
  return path.split('/').at(-1)?.replace(/\.mm$/, '') || 'Carte'
}

/**
 * Ancien contenu (instantane JSON d'avant le CRDT), lu dans la room de
 * l'ancien mode. Rend aussi la room, pour y marquer la migration.
 */
async function openLegacy(ctx: FileContext, sync: PluginAPI['sync'] | undefined): Promise<{ data: MindElixirData | null; room: DocumentRoom | null }> {
  const docId = ctx.vault?.resolveDocumentId(ctx.path)
  if (!sync || !docId) return { data: null, room: null }
  const room = await sync.openRoom(ctx.vaultId, docId, ctx.userId ?? 'anonymous')
  return { data: parseLegacy((await room.initialSnapshot) ?? null), room }
}

export function createMindmapView(path: string, ctx: FileContext, api: PluginAPI | null) {
  let editor: MindmapEditor | null = null
  let room: DocumentRoom | null = null
  let generation = 0

  const closeRoom = () => {
    room?.close().catch(() => {})
    room = null
  }

  return {
    mount(container: HTMLElement) {
      const gen = ++generation
      editor?.destroy()
      closeRoom()

      editor = new MindmapEditor({
        parent: container,
        tree: ctx.tree,
        title: fileTitle(path),
        readOnly: ctx.readOnly,
        onKeyDown: e => api?.hotkeys?.handleKeyEvent(e, { editorView: null }) ?? false,
        onMigrated: () => {
          // Marque l'ancien instantane : un membre qui ouvre la carte plus
          // tard ne le recopiera pas une seconde fois. Le contenu reste
          // dedans, pour revenir en arriere au besoin.
          const r = room
          const data = editor?.me.getData()
          if (!r || !data) return
          r.pushSnapshot(JSON.stringify({ ...data, migratedToCrdt: true }))
            .catch(err => console.warn('[plugin-mindmap] marque de migration', err))
            .finally(() => { if (room === r) closeRoom() })
        },
      })

      if (!ctx.tree) {
        // Pas d'arbre partage (pas de session de vault) : on affiche le
        // fichier sans l'editer. Un type 'crdt' n'a pas de verrou : ecrire
        // des instantanes ferait perdre le travail d'un autre membre.
        const note = document.createElement('div')
        note.dataset.testid = 'mindmap-readonly-note'
        note.textContent = 'Lecture seule : cette carte n\'est pas reliée à la synchronisation du vault.'
        note.style.cssText = 'position:absolute;top:0;left:0;right:0;z-index:20;padding:6px 16px;font:12px var(--font-ui,sans-serif);color:var(--text-muted,#64748b);background:var(--bg-base,#1e1e2e);border-bottom:1px solid var(--border,#313244)'
        container.appendChild(note)
        ctx.vault?.readDocumentByPath(path)
          .then(raw => { if (gen === generation) editor?.setLegacy(parseLegacy(raw)) })
          .catch(err => console.error('[plugin-mindmap] lecture impossible', path, err))
        return
      }

      // Ancien fichier .mm : son instantane est affiche tant que l'arbre est
      // vide, et recopie a la premiere modification.
      openLegacy(ctx, api?.sync)
        .then(({ data, room: r }) => {
          if (gen !== generation) { r?.close().catch(() => {}); return }
          room = r
          if (data) editor?.setLegacy(data)
          else closeRoom()
        })
        .catch(err => console.warn('[plugin-mindmap] ancien contenu illisible', err))
    },

    setReadOnly(readOnly: boolean) {
      editor?.setReadOnly(readOnly)
    },

    destroy() {
      generation++
      closeRoom()
      editor?.destroy()
      editor = null
    },
  }
}
