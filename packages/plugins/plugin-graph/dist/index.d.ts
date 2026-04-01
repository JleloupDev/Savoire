import type { VaultPlugin } from '@poc/plugin-api';
import { GraphIndexContributor } from './GraphIndexContributor';
export interface GraphPluginHandle {
    plugin: VaultPlugin;
    /** Contributor exposé pour permettre un bulkLoad au chargement du vault. */
    contributor: GraphIndexContributor;
}
export declare function createGraphPlugin(options?: {
    tabOf?: string;
}): GraphPluginHandle;
export { GraphIndexContributor } from './GraphIndexContributor';
//# sourceMappingURL=index.d.ts.map