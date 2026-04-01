import React from 'react';
import type { VaultAPI } from '@poc/plugin-api';
import { WorkspaceManagerImpl } from './WorkspaceManagerImpl';
import 'dockview/dist/styles/dockview.css';
export interface WorkspaceRootProps {
    /** VaultAPI instance provided to all views via ViewContext. */
    vault: VaultAPI;
    /**
     * Called after Dockview is initialized but BEFORE panels are opened.
     * May be async — panels are not opened until this resolves.
     * Use this to register views (e.g. load plugins) so they appear on first render.
     */
    onBeforeReady?: (manager: WorkspaceManagerImpl) => void | Promise<void>;
    /** Called once panels are open and the workspace is fully ready. */
    onReady?: (manager: WorkspaceManagerImpl) => void;
    className?: string;
    style?: React.CSSProperties;
}
export declare function WorkspaceRoot({ vault, onBeforeReady, onReady, className, style }: WorkspaceRootProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=WorkspaceRoot.d.ts.map