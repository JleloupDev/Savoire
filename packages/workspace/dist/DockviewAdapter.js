/**
 * DockviewAdapter — implements WorkspacePort using the Dockview layout engine.
 * DECISION: isolated behind WorkspacePort so Dockview can be swapped without
 * touching WorkspaceManager or any plugin.
 *
 * Usage: create the adapter, pass it to WorkspaceManagerImpl, then call
 * setApi() once DockviewReact fires its onReady callback.
 */
export class DockviewAdapter {
    api = null;
    /** Called by WorkspaceRoot once Dockview is mounted and ready. */
    setApi(api) {
        this.api = api;
    }
    openPanel(panelId, options) {
        if (!this.api)
            throw new Error('DockviewAdapter: not initialized — call setApi() first');
        const existing = this.api.getPanel(panelId);
        if (existing) {
            existing.focus();
            return this.toInstance(existing);
        }
        const panel = this.api.addPanel({
            id: panelId,
            component: options?.component ?? panelId,
            title: options?.title ?? panelId,
        });
        return this.toInstance(panel);
    }
    closePanel(panelId) {
        const panel = this.api?.getPanel(panelId);
        if (panel)
            this.api?.removePanel(panel);
    }
    focusPanel(panelId) {
        this.api?.getPanel(panelId)?.focus();
    }
    saveLayout() {
        const panels = this.api?.panels ?? [];
        return {
            panels: panels.map(p => ({
                id: p.id,
                location: 'center',
                views: [],
            })),
        };
    }
    restoreLayout(_layout) {
        // POC: no-op — layout restoration not in scope
    }
    toInstance(panel) {
        return {
            id: panel.id,
            focus: () => panel.focus(),
            close: () => {
                if (this.api)
                    this.api.removePanel(panel);
            },
        };
    }
}
//# sourceMappingURL=DockviewAdapter.js.map