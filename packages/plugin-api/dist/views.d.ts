export interface Widget {
    /** Returns React.ReactNode in practice — typed unknown to avoid React dep in plugin-api. */
    render(): unknown;
    dispose?(): void;
}
import type { WorkspaceAPI } from './workspace';
import type { VaultAPI } from './vault';
export interface ViewContext {
    workspace: WorkspaceAPI;
    vault: VaultAPI;
}
export interface ViewSpec {
    id: string;
    title: string;
    icon?: string;
    /** 'left' | 'right' | 'bottom' | 'center' */
    container: string;
    /** If set, panel is added as a tab next to this panel ID (same group). */
    tabOf?: string;
    /** If set, panel is placed below this panel ID (split horizontally). */
    belowOf?: string;
    /** false = no close button (permanent panel). Default: true */
    closable?: boolean;
    /** Initial size in px — width for left/right, height for bottom. */
    initialSize?: number;
    createView(ctx: ViewContext): Widget;
}
export interface ViewRegistry {
    register(spec: ViewSpec): void;
    unregister(id: string): void;
    getAll(): ViewSpec[];
}
//# sourceMappingURL=views.d.ts.map