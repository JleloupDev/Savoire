import type { DockviewApi } from 'dockview';
import type { WorkspacePort, WorkspaceLayout, OpenPanelOptions, PanelInstance } from './types';
/**
 * DockviewAdapter — implements WorkspacePort using the Dockview layout engine.
 * DECISION: isolated behind WorkspacePort so Dockview can be swapped without
 * touching WorkspaceManager or any plugin.
 *
 * Usage: create the adapter, pass it to WorkspaceManagerImpl, then call
 * setApi() once DockviewReact fires its onReady callback.
 */
export declare class DockviewAdapter implements WorkspacePort {
    private api;
    /** Called by WorkspaceRoot once Dockview is mounted and ready. */
    setApi(api: DockviewApi): void;
    openPanel(panelId: string, options?: OpenPanelOptions): PanelInstance;
    closePanel(panelId: string): void;
    focusPanel(panelId: string): void;
    saveLayout(): WorkspaceLayout;
    restoreLayout(_layout: WorkspaceLayout): void;
    private toInstance;
}
//# sourceMappingURL=DockviewAdapter.d.ts.map