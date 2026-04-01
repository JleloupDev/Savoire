import { jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
import React, { useState, useCallback, useMemo } from 'react';
import { DockviewReact, DockviewDefaultTab } from 'dockview';
import { DockviewAdapter } from './DockviewAdapter';
import { WorkspaceManagerImpl } from './WorkspaceManagerImpl';
import { WorkspaceContext } from './WorkspaceContext';
import 'dockview/dist/styles/dockview.css';
// ─── Permanent tab — no close button ──────────────────────────────────────
function PermanentTab(props) {
    return _jsx(DockviewDefaultTab, { ...props, hideClose: true });
}
function ViewPanelHost(props) {
    // DECISION: create the widget once per panel lifecycle, not on every render.
    const [widget] = useState(() => props.params.spec.createView(props.params.ctx));
    React.useEffect(() => {
        return () => {
            widget.dispose?.();
        };
    }, [widget]);
    return _jsx(_Fragment, { children: widget.render() });
}
// ─── WorkspaceRoot ─────────────────────────────────────────────────────────
export function WorkspaceRoot({ vault, onBeforeReady, onReady, className, style }) {
    // DECISION: WorkspaceRoot owns the adapter — it's the only component that knows
    // when Dockview is ready and can call setApi().
    const adapter = useMemo(() => new DockviewAdapter(), []);
    const manager = useMemo(() => new WorkspaceManagerImpl(adapter), [adapter]);
    const onDockviewReady = useCallback((event) => {
        adapter.setApi(event.api);
        // onBeforeReady may be async (plugin loading). Wait for it before opening panels.
        const setup = onBeforeReady?.(manager) ?? Promise.resolve();
        void Promise.resolve(setup).then(() => {
            // DECISION: open center panels first so sidebar panels can be positioned relative to them.
            // tabOf panels must come after their reference panels.
            const sorted = [...manager.views.getAll()].sort((a, b) => {
                if (a.container === 'center' && b.container !== 'center')
                    return -1;
                if (b.container === 'center' && a.container !== 'center')
                    return 1;
                if (a.tabOf === b.id)
                    return 1; // a goes after b (its tab group owner)
                if (b.tabOf === a.id)
                    return -1;
                if (a.belowOf === b.id)
                    return 1; // a goes after b (its below reference)
                if (b.belowOf === a.id)
                    return -1;
                return 0;
            });
            const ctx = { workspace: manager, vault };
            let firstCenterId;
            for (const spec of sorted) {
                let position;
                if (spec.tabOf) {
                    // Add as a new tab in the same group as the reference panel
                    if (event.api.getPanel(spec.tabOf)) {
                        position = { referencePanel: spec.tabOf };
                    }
                }
                else if (spec.belowOf) {
                    // Add as a split below the reference panel
                    if (event.api.getPanel(spec.belowOf)) {
                        position = { referencePanel: spec.belowOf, direction: 'below' };
                    }
                }
                else if (spec.container !== 'center' && firstCenterId) {
                    position = {
                        direction: spec.container === 'left' ? 'left' : spec.container === 'right' ? 'right' : 'below',
                        referencePanel: firstCenterId,
                    };
                }
                const panelOptions = {
                    id: spec.id,
                    component: 'view',
                    title: spec.title,
                    params: { spec, ctx },
                    position,
                    tabComponent: spec.closable === false ? 'permanent' : undefined,
                    initialWidth: spec.container === 'left' || spec.container === 'right' ? spec.initialSize : undefined,
                    initialHeight: spec.container === 'bottom' ? spec.initialSize : undefined,
                };
                try {
                    event.api.addPanel(panelOptions);
                }
                catch (err) {
                    // Dockview can fail when a computed reference container is not yet attached.
                    // Fallback to root insertion so workspace still boots.
                    if (position) {
                        try {
                            event.api.addPanel({ ...panelOptions, position: undefined });
                        }
                        catch (fallbackErr) {
                            console.error('[WorkspaceRoot] Failed to add panel', spec.id, fallbackErr);
                            console.error(err);
                        }
                    }
                    else {
                        console.error('[WorkspaceRoot] Failed to add panel', spec.id, err);
                    }
                }
                if (spec.container === 'center' && !firstCenterId) {
                    firstCenterId = spec.id;
                }
            }
            onReady?.(manager);
        });
    }, [adapter, manager, vault, onBeforeReady, onReady]);
    const rootClassName = ['workspace-root', className].filter(Boolean).join(' ');
    return (_jsx(WorkspaceContext.Provider, { value: manager, children: _jsx("div", { className: rootClassName, style: { width: '100%', height: '100%', ...style }, children: _jsx(DockviewReact, { components: { view: ViewPanelHost }, tabComponents: { permanent: PermanentTab }, onReady: onDockviewReady }) }) }));
}
//# sourceMappingURL=WorkspaceRoot.js.map