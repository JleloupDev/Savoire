import type { WorkspaceAPI, ViewDocument } from '@poc/plugin-api';
import type { WorkspacePort, WorkspaceLayout } from './types';
import { ViewRegistryImpl } from './ViewRegistryImpl';
/**
 * WorkspaceManager — orchestrates panels, views and layout.
 * Does NOT depend on Dockview directly; delegates to WorkspacePort.
 * DECISION: thin manager keeps layout logic testable without a DOM.
 */
export declare class WorkspaceManagerImpl implements WorkspaceAPI {
    private readonly port;
    readonly views: ViewRegistryImpl;
    private activeDocument;
    private openFileCallbacks;
    private vaultChangeCallbacks;
    constructor(port: WorkspacePort);
    openFile(path: string): Promise<void>;
    /**
     * Subscribe to openFile events — used by EditorAreaWidget to know when
     * a file was selected in the filetree and load its content.
     * Returns an unsubscribe function.
     */
    subscribeOpenFile(cb: (path: string) => void): () => void;
    subscribeVaultChange(cb: () => void): () => void;
    notifyVaultChange(): void;
    openPanel(panelId: string): void;
    closePanel(panelId: string): void;
    focusPanel(panelId: string): void;
    getActiveDocument(): ViewDocument | undefined;
    saveLayout(): WorkspaceLayout;
    restoreLayout(layout: WorkspaceLayout): void;
}
//# sourceMappingURL=WorkspaceManagerImpl.d.ts.map