// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import React, { useState, useCallback, useMemo } from 'react'
import { DockviewReact, DockviewDefaultTab } from 'dockview'
import type { DockviewReadyEvent, IDockviewPanelProps, IDockviewPanelHeaderProps } from 'dockview'
import type { VaultAPI, ViewSpec, ViewContext, Widget } from '@savoire/plugin-api'
import { DockviewAdapter } from './DockviewAdapter'
import { WorkspaceManagerImpl } from './WorkspaceManagerImpl'
import { WorkspaceContext } from './WorkspaceContext'
import 'dockview/dist/styles/dockview.css'

export interface WorkspaceRootProps {
  /** VaultAPI instance provided to all views via ViewContext. */
  vault: VaultAPI
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

  return <>{widget.render() as React.ReactNode}</>
}

// ─── WorkspaceRoot ─────────────────────────────────────────────────────────

export function WorkspaceRoot({ vault, onBeforeReady, onReady, className, style }: WorkspaceRootProps) {
  // see ADR-011
  const adapter = useMemo(() => new DockviewAdapter(), [])
  const manager = useMemo(() => new WorkspaceManagerImpl(adapter), [adapter])

  const onDockviewReady = useCallback(
    (event: DockviewReadyEvent) => {
      adapter.setApi(event.api)

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
        const ctx: ViewContext = { workspace: manager, vault }
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
            initialHeight: spec.container === 'bottom' ? spec.initialSize : undefined,
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

        onReady?.(manager)
      })
    },
    [adapter, manager, vault, onBeforeReady, onReady],
  )

  const rootClassName = ['workspace-root', className].filter(Boolean).join(' ')

  return (
    <WorkspaceContext.Provider value={manager}>
      {/* Wrapper carries style/className; DockviewReact fills it at 100% */}
      <div className={rootClassName} style={{ width: '100%', height: '100%', ...style }}>
        <DockviewReact
          components={{ view: ViewPanelHost as React.FC<IDockviewPanelProps> }}
          tabComponents={{ permanent: PermanentTab }}
          onReady={onDockviewReady}
        />
      </div>
    </WorkspaceContext.Provider>
  )
}
