import type { VaultPlugin, PluginAPI, IPluginLoader } from '@poc/plugin-api';
import { PluginSandbox } from './PluginSandbox';
export interface PluginEntry {
    id: string;
    sandbox: PluginSandbox | null;
    plugin: VaultPlugin | null;
}
export declare class PluginLoader implements IPluginLoader {
    private loaded;
    loadFromCode(id: string, code: string, api: PluginAPI): Promise<void>;
    loadFromUrl(id: string, url: string, api: PluginAPI): Promise<void>;
    /**
     * Load a first-party plugin directly — no Blob URL sandbox, no network.
     * Every BlockSpec registered during onload() is automatically tagged with the
     * plugin's manifest id, enabling per-note activation filtering in LivePreview.
     */
    loadInternal(plugin: VaultPlugin, api: PluginAPI): Promise<void>;
    unload(id: string): Promise<void>;
    unloadAll(): Promise<void>;
    isLoaded(id: string): boolean;
    getLoadedIds(): string[];
    getAll(): PluginEntry[];
}
//# sourceMappingURL=PluginLoader.d.ts.map