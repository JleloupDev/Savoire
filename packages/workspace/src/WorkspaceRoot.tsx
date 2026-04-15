// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { DockviewReact, DockviewDefaultTab } from 'dockview'
import type { DockviewReadyEvent, IDockviewPanelProps, IDockviewPanelHeaderProps } from 'dockview'
import type { VaultAPI, ViewSpec, ViewContext, Widget, FileTypeRegistry } from '@savoire/plugin-api'
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

// ─── WorkspaceRoot ─────────────────────────────────────────────────────────

export function WorkspaceRoot({ vault, fileTypesRef, onBeforeReady, onReady, className, style }: WorkspaceRootProps) {
  // see ADR-011
  const adapter = useMemo(() => new DockviewAdapter(), [])
  const manager = useMemo(() => new WorkspaceManagerImpl(adapter), [adapter])
  const [leftCollapsed,  setLeftCollapsed]  = useState(manager.getPaneState('left').collapsed)
  const [rightCollapsed, setRightCollapsed] = useState(manager.getPaneState('right').collapsed)
  const leftToggleRef  = React.useRef<HTMLButtonElement>(null)
  const rightToggleRef = React.useRef<HTMLButtonElement>(null)

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
        const sorted = [...manager.views.getAll()].sort((a, b) => {
          if (a.container === 'center' && b.container !== 'center') return -1
          if (b.container === 'center' && a.container !== 'center') return 1
          if (a.tabOf === b.id) return 1  // a goes after b (its tab group owner)
          if (b.tabOf === a.id) return -1
          if (a.belowOf === b.id) return 1  // a goes after b (its below reference)
          if (b.belowOf === a.id) return -1
          return 0
        })
        const ctx: ViewContext = { workspace: manager, vault, fileTypes: fileTypesRef?.current ?? noopFileTypeRegistry }
        let firstCenterId: string | undefined

        for (const spec of sorted) {
          let position: { referencePanel: string; direction?: 'left' | 'right' | 'below' } | undefined

          if (spec.tabOf) {
            // Add as a new tab in the same group as the reference panel
            if (event.api.getPanel(spec.tabOf)) {
              position = { referencePanel: spec.tabOf }
            }
          } else if (spec.belowOf) {
            // Add as a split below the reference panel
            if (event.api.getPanel(spec.belowOf)) {
              position = { referencePanel: spec.belowOf, direction: 'below' }
            }
          } else if (spec.container !== 'center' && firstCenterId) {
            position = {
              direction: spec.container === 'left' ? 'left' : spec.container === 'right' ? 'right' : 'below',
              referencePanel: firstCenterId,
            }
          }

          const panelOptions = {
            id: spec.id,
            component: 'view',
            title: spec.title,
            params: { spec, ctx } satisfies ViewPanelParams,
            position,
            tabComponent: spec.closable === false ? 'permanent' : undefined,
            initialWidth: spec.container === 'left' || spec.container === 'right' ? spec.initialSize : undefined,
            initialHeight: spec.container === 'bottom' || !!spec.belowOf ? spec.initialSize : undefined,
          }

          try {
            event.api.addPanel(panelOptions)
          } catch (err) {
            // Dockview can fail when a computed reference container is not yet attached.
            // Fallback to root insertion so workspace still boots.
            if (position) {
              try {
                event.api.addPanel({ ...panelOptions, position: undefined })
              } catch (fallbackErr) {
                console.error('[WorkspaceRoot] Failed to add panel', spec.id, fallbackErr)
                console.error(err)
              }
            } else {
              console.error('[WorkspaceRoot] Failed to add panel', spec.id, err)
            }
          }

          if (spec.container === 'center' && !firstCenterId) {
            firstCenterId = spec.id
          }
        }

        // Attach ResizeObserver to group DOM elements for live tracking during sash drag
        const leftAnchorId  = manager.getPaneAnchorPanelId('left')
        const rightAnchorId = manager.getPaneAnchorPanelId('right')
        leftGroupEl  = leftAnchorId  ? (event.api.getPanel(leftAnchorId)?.group.element  ?? null) : null
        rightGroupEl = rightAnchorId ? (event.api.getPanel(rightAnchorId)?.group.element ?? null) : null
        if (leftGroupEl)  resizeObserver.observe(leftGroupEl)
        if (rightGroupEl) resizeObserver.observe(rightGroupEl)

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
          aria-label={leftCollapsed ? 'Expand left pane' : 'Collapse left pane'}
          title={leftCollapsed ? 'Expand left pane' : 'Collapse left pane'}
          onClick={() => manager.togglePane('left')}
        >
          <ChevronIcon direction={leftCollapsed ? 'right' : 'left'} />
        </button>
        <button
          ref={rightToggleRef}
          type="button"
          className={`workspace-pane-toggle workspace-pane-toggle-right${rightCollapsed ? ' workspace-pane-toggle--at-edge' : ''}`}
          aria-label={rightCollapsed ? 'Expand right pane' : 'Collapse right pane'}
          title={rightCollapsed ? 'Expand right pane' : 'Collapse right pane'}
          onClick={() => manager.togglePane('right')}
        >
          <ChevronIcon direction={rightCollapsed ? 'left' : 'right'} />
        </button>
      </div>
    </WorkspaceContext.Provider>
  )
}
