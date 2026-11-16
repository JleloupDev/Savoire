// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { DockviewReact, DockviewDefaultTab } from 'dockview'
import type { DockviewApi, DockviewReadyEvent, IDockviewPanelProps, IDockviewPanelHeaderProps } from 'dockview'
import type { VaultAPI, ViewSpec, ViewContext, Widget, FileTypeRegistry } from '@savoire/plugin-api'
import { t } from '@savoire/i18n'
import { DockviewAdapter } from './DockviewAdapter'
import { WorkspaceManagerImpl } from './WorkspaceManagerImpl'
import { WorkspaceContext } from './WorkspaceContext'
import 'dockview/dist/styles/dockview.css'

const noopFileTypeRegistry: FileTypeRegistry = {
  register: () => {},
  unregister: () => {},
  resolve: () => undefined,
  getAll: () => [],
}

export interface WorkspaceRootProps {
  /** VaultAPI instance provided to all views via ViewContext. */
  vault: VaultAPI
  /**
   * Ref to the FileTypeRegistry — resolved after onBeforeReady (plugins loaded).
   * Views can then enumerate registered file types via ctx.fileTypes.getAll().
   */
  fileTypesRef?: React.MutableRefObject<FileTypeRegistry | null>
  /**
   * Called after Dockview is initialized but BEFORE panels are opened.
   * May be async — panels are not opened until this resolves.
   * Use this to register views (e.g. load plugins) so they appear on first render.
   */
  onBeforeReady?: (manager: WorkspaceManagerImpl) => void | Promise<void>
  /** Called once panels are open and the workspace is fully ready. */
  onReady?: (manager: WorkspaceManagerImpl) => void
  className?: string
  style?: React.CSSProperties
}

// ─── Permanent tab — no close button ──────────────────────────────────────

function PermanentTab(props: IDockviewPanelHeaderProps) {
  return <DockviewDefaultTab {...props} hideClose />
}

// ─── Chevron icon ──────────────────────────────────────────────────────────

function ChevronIcon({ direction }: { direction: 'left' | 'right' }) {
  return (
    <svg width="8" height="12" viewBox="0 0 8 12" fill="none" aria-hidden="true" style={{ display: 'block' }}>
      {direction === 'left'
        ? <path d="M7 1L1 6L7 11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        : <path d="M1 1L7 6L1 11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      }
    </svg>
  )
}

// ─── Generic view host panel ───────────────────────────────────────────────

interface ViewPanelParams {
  spec: ViewSpec
  ctx: ViewContext
}

function ViewPanelHost(props: IDockviewPanelProps<ViewPanelParams>) {
  const [widget] = useState<Widget>(() => props.params.spec.createView(props.params.ctx))

  React.useEffect(() => {
    return () => {
      widget.dispose?.()
    }
  }, [widget])

  return (
    <div className="workspace-view-host" data-view-location={props.params.spec.container}>
      {widget.render() as React.ReactNode}
    </div>
  )
}

// ─── Panel creation helper ─────────────────────────────────────────────────

function addPanelToWorkspace(
  spec: ViewSpec,
  ctx: ViewContext,
  api: DockviewApi,
  firstCenterId: string | undefined,
): void {
  let position: { referencePanel: string; direction?: 'left' | 'right' | 'below' } | undefined

  if (spec.tabOf && api.getPanel(spec.tabOf)) {
    position = { referencePanel: spec.tabOf }
  } else if (spec.belowOf && api.getPanel(spec.belowOf)) {
    position = { referencePanel: spec.belowOf, direction: 'below' }
  } else if (spec.container !== 'center' && firstCenterId) {
    position = {
      direction: spec.container === 'left' ? 'left' : 'right',
      referencePanel: firstCenterId,
    }
  } else if (spec.container === 'center' && firstCenterId && api.getPanel(firstCenterId)) {
    // Vue principale : onglet a cote de l'editeur, pas dans le groupe actif
    // (qui peut etre un volet quand elle revient en cours de route).
    position = { referencePanel: firstCenterId }
  }

  const panelOptions = {
    id: spec.id,
    component: 'view',
    title: spec.title,
    params: { spec, ctx } satisfies ViewPanelParams,
    position,
    tabComponent: spec.closable === false ? 'permanent' : undefined,
    initialWidth: spec.container === 'left' || spec.container === 'right' ? spec.initialSize : undefined,
    initialHeight: spec.belowOf ? spec.initialSize : undefined,
  }

  try {
    api.addPanel(panelOptions)
  } catch (err) {
    if (position) {
      try { api.addPanel({ ...panelOptions, position: undefined }) } catch (e2) {
        console.error('[WorkspaceRoot] Failed to add panel', spec.id, e2, err)
      }
    } else {
      console.error('[WorkspaceRoot] Failed to add panel', spec.id, err)
    }
  }
}

// ─── Right/center panels ───────────────────────────────────────────────────

/**
 * Pose les panneaux droite/centre visibles qui ne sont pas encore dans la
 * mise en page. Au demarrage : tous. Ensuite : ceux qui reviennent (plugin
 * reactive, panneau remis par la disposition). Rend les ancres centre/droite.
 */
function placeDockedPanels(
  manager: WorkspaceManagerImpl,
  ctx: ViewContext,
  api: DockviewApi,
): { center?: string; right?: string } {
  const groups = manager.views.getGroups()
  const groupAnchor = new Map<string, string>()
  for (const spec of manager.views.getAll()) {
    if (spec.groupId && !groupAnchor.has(spec.groupId)) {
      groupAnchor.set(spec.groupId, spec.id)
    }
  }

  // Track the last registered view per group to chain belowOf in stack mode
  const groupLastView = new Map<string, string>() // groupId → last added view id

  const resolved = manager.views.getAll()
    .filter(spec => {
      const container = spec.groupId
        ? (groups.find(g => g.id === spec.groupId)?.container ?? spec.container)
        : spec.container
      return container !== 'left'
    })
    .map(spec => {
      if (!spec.groupId) return spec
      const group = groups.find(g => g.id === spec.groupId)
      if (!group) return spec
      const anchorId = groupAnchor.get(spec.groupId)!
      if (spec.id === anchorId) {
        groupLastView.set(spec.groupId, spec.id)
        return { ...spec, container: group.container, initialSize: spec.initialSize ?? group.initialSize, closable: spec.closable ?? group.closable, tabOf: undefined, belowOf: undefined }
      }
      if (group.layout === 'stack') {
        const prevId = groupLastView.get(spec.groupId) ?? anchorId
        groupLastView.set(spec.groupId, spec.id)
        return { ...spec, container: group.container, belowOf: prevId, tabOf: undefined }
      }
      groupLastView.set(spec.groupId, spec.id)
      return { ...spec, container: group.container, tabOf: anchorId, belowOf: undefined }
    })

  // Une vue rattachee a un panneau masque (« Versions » a cote de « Révision »)
  // rejoint la colonne de droite au lieu d'en ouvrir une nouvelle.
  const visibleIds = new Set(resolved.map(spec => spec.id))
  const attached = resolved.map(spec => ({
    ...spec,
    tabOf: spec.tabOf && visibleIds.has(spec.tabOf) ? spec.tabOf : undefined,
    belowOf: spec.belowOf && visibleIds.has(spec.belowOf) ? spec.belowOf : undefined,
  }))

  const sorted = [...attached].sort((a, b) => {
    if (a.container === 'center' && b.container !== 'center') return -1
    if (b.container === 'center' && a.container !== 'center') return 1
    if (a.tabOf === b.id) return 1
    if (b.tabOf === a.id) return -1
    if (a.belowOf === b.id) return 1
    if (b.belowOf === a.id) return -1
    return 0
  })

  // Panneaux deja poses : ils servent d'ancres aux nouveaux.
  let firstCenterId = sorted.find(spec => spec.container === 'center' && api.getPanel(spec.id))?.id
  let firstRightId = sorted.find(spec => spec.container === 'right' && api.getPanel(spec.id))?.id
  for (const spec of sorted) {
    if (api.getPanel(spec.id)) continue
    // All right-container panels that have no explicit tabOf/belowOf are auto-tabbed
    // to the first right panel so they share a single dockview column.
    const needsRightAnchor =
      spec.container === 'right' && !spec.tabOf && !spec.belowOf && firstRightId && spec.id !== firstRightId
    const resolvedSpec = needsRightAnchor ? { ...spec, tabOf: firstRightId } : spec
    addPanelToWorkspace(resolvedSpec, ctx, api, firstCenterId)
    if (spec.container === 'center' && !firstCenterId) firstCenterId = spec.id
    if (spec.container === 'right' && !firstRightId) firstRightId = spec.id
  }
  return { center: firstCenterId, right: firstRightId }
}

// ─── WorkspaceRoot ─────────────────────────────────────────────────────────

export function WorkspaceRoot({ vault, fileTypesRef, onBeforeReady, onReady, className, style }: WorkspaceRootProps) {
  // see ADR-011
  const adapter = useMemo(() => new DockviewAdapter(), [])
  const manager = useMemo(() => new WorkspaceManagerImpl(adapter), [adapter])
  const [leftCollapsed,  setLeftCollapsed]  = useState(manager.getPaneState('left').collapsed)
  const [rightCollapsed, setRightCollapsed] = useState(manager.getPaneState('right').collapsed)
  const leftToggleRef  = React.useRef<HTMLButtonElement>(null)
  const rightToggleRef = React.useRef<HTMLButtonElement>(null)

  // StrictMode mounts, unmounts, and remounts every component once in dev to
  // surface missing cleanup. onDockviewReady's continuation below is async
  // (awaits onBeforeReady/plugin bootstrap) and touches the shared Dockview
  // API and `onReady` callback — without this guard, a discarded first mount
  // can still finish its async work after being unmounted and add a second,
  // orphaned set of panels alongside the real one.
  const mountedRef = React.useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => manager.subscribePaneState('left',  s => setLeftCollapsed(s.collapsed)),  [manager])
  useEffect(() => manager.subscribePaneState('right', s => setRightCollapsed(s.collapsed)), [manager])

  const onDockviewReady = useCallback(
    (event: DockviewReadyEvent) => {
      adapter.setApi(event.api)

      // Update button positions directly in the DOM — bypasses React batching for smooth drag tracking.
      // Reads offsetWidth from the group DOM element so it fires continuously during sash drag
      // (onDidLayoutChange only fires after drag ends).
      let leftGroupEl: Element | null = null
      let rightGroupEl: Element | null = null

      const updateButtonPositions = () => {
        if (leftToggleRef.current) {
          const w = (leftGroupEl as HTMLElement | null)?.offsetWidth ?? 0
          leftToggleRef.current.style.left = `${Math.max(0, w - 8)}px`
        }
        if (rightToggleRef.current) {
          const w = (rightGroupEl as HTMLElement | null)?.offsetWidth ?? 0
          rightToggleRef.current.style.right = `${Math.max(0, w - 8)}px`
        }
      }

      const resizeObserver = new ResizeObserver(updateButtonPositions)

      // onBeforeReady may be async (plugin loading). Wait for it before opening panels.
      const setup = onBeforeReady?.(manager) ?? Promise.resolve()
      void Promise.resolve(setup).then(() => {
        if (!mountedRef.current) return
        const ctx: ViewContext = { workspace: manager, vault, fileTypes: fileTypesRef?.current ?? noopFileTypeRegistry }

        // Right/center panels now; left ones lazily via switchLeftMode.
        const placeDocked = () => placeDockedPanels(manager, ctx, event.api)
        const anchors = placeDocked()
        const firstCenterId = anchors.center

        // ── Left panel adder — given to WorkspaceManagerImpl for lazy mode switching ──
        manager.setLeftPanelAdder((spec, panelCtx) => {
          addPanelToWorkspace(spec, panelCtx, event.api, firstCenterId)
          // Attach ResizeObserver to the new left group for toggle button tracking
          const leftPanel = event.api.getPanel(spec.id)
          if (leftPanel && !leftGroupEl) {
            leftGroupEl = leftPanel.group.element
            resizeObserver.observe(leftGroupEl)
            updateButtonPositions()
          }
        }, ctx)

        // Attach ResizeObserver to right group (again when panels come back).
        const observeRightGroup = () => {
          const rightAnchorId = manager.getPaneAnchorPanelId('right')
          const el = rightAnchorId ? (event.api.getPanel(rightAnchorId)?.group.element ?? null) : null
          if (el === rightGroupEl) return
          if (rightGroupEl) resizeObserver.unobserve(rightGroupEl)
          rightGroupEl = el
          if (rightGroupEl) resizeObserver.observe(rightGroupEl)
          updateButtonPositions()
        }
        observeRightGroup()
        manager.setDockedPanelSyncer(() => { placeDocked(); observeRightGroup() })

        updateButtonPositions()
        onReady?.(manager)
      })
    },
    [adapter, manager, vault, onBeforeReady, onReady],
  )

  const rootClassName = [
    'workspace-root',
    leftCollapsed  ? 'workspace-left-collapsed'  : '',
    rightCollapsed ? 'workspace-right-collapsed' : '',
    className,
  ].filter(Boolean).join(' ')

  return (
    <WorkspaceContext.Provider value={manager}>
      {/* Wrapper carries style/className; DockviewReact fills it at 100% */}
      <div className={rootClassName} style={{ position: 'relative', width: '100%', height: '100%', ...style }}>
        <DockviewReact
          components={{ view: ViewPanelHost as React.FC<IDockviewPanelProps> }}
          tabComponents={{ permanent: PermanentTab }}
          onReady={onDockviewReady}
        />

        {/* Toggle buttons — always visible, positioned at the inner edge of each side pane.
            Position is driven by direct DOM updates in updateButtonPositions (smooth drag tracking). */}
        <button
          ref={leftToggleRef}
          type="button"
          className={`workspace-pane-toggle workspace-pane-toggle-left${leftCollapsed ? ' workspace-pane-toggle--at-edge' : ''}`}
          aria-label={leftCollapsed ? t('layout', 'pane.left.expand') : t('layout', 'pane.left.collapse')}
          title={leftCollapsed ? t('layout', 'pane.left.expand') : t('layout', 'pane.left.collapse')}
          onClick={() => manager.togglePane('left')}
        >
          <ChevronIcon direction={leftCollapsed ? 'right' : 'left'} />
        </button>
        <button
          ref={rightToggleRef}
          type="button"
          className={`workspace-pane-toggle workspace-pane-toggle-right${rightCollapsed ? ' workspace-pane-toggle--at-edge' : ''}`}
          aria-label={rightCollapsed ? t('layout', 'pane.right.expand') : t('layout', 'pane.right.collapse')}
          title={rightCollapsed ? t('layout', 'pane.right.expand') : t('layout', 'pane.right.collapse')}
          onClick={() => manager.togglePane('right')}
        >
          <ChevronIcon direction={rightCollapsed ? 'left' : 'right'} />
        </button>
      </div>
    </WorkspaceContext.Provider>
  )
}
