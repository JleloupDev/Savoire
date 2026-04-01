import type { VaultPlugin } from '@poc/plugin-api';
export interface FileTreePluginOptions {
    viewId?: string;
    title?: string;
    icon?: string;
    container?: 'left' | 'right' | 'center' | 'bottom';
    tabOf?: string;
    belowOf?: string;
    closable?: boolean;
    initialSize?: number;
}
export declare function createFileTreePlugin(options?: FileTreePluginOptions): VaultPlugin;
declare const plugin: VaultPlugin;
export default plugin;
export { FileTreeWidget } from './FileTreeWidget';
export { FileTree } from './FileTreeWidget';
//# sourceMappingURL=index.d.ts.map