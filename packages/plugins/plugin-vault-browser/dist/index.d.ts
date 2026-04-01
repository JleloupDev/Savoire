import type { VaultPlugin } from '@poc/plugin-api';
import { type VaultBrowserRefs, type VaultSummaryLike } from './VaultBrowserWidget';
export interface VaultBrowserPluginOptions<TVault extends VaultSummaryLike = VaultSummaryLike> {
    refs: VaultBrowserRefs<TVault>;
    viewId?: string;
    title?: string;
    container?: 'left' | 'right' | 'center' | 'bottom';
    initialSize?: number;
    tabOf?: string;
    belowOf?: string;
    closable?: boolean;
}
export declare function createVaultBrowserPlugin<TVault extends VaultSummaryLike = VaultSummaryLike>(options: VaultBrowserPluginOptions<TVault>): VaultPlugin;
export { VaultBrowserWidget } from './VaultBrowserWidget';
export type { VaultBrowserRefs, VaultSummaryLike, VaultBrowserWorkspaceLike } from './VaultBrowserWidget';
//# sourceMappingURL=index.d.ts.map