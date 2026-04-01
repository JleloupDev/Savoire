import type { PluginAPI } from '@poc/plugin-api';
export declare class PluginSandbox {
    private plugin;
    private blobUrl;
    load(code: string, api: PluginAPI): Promise<void>;
    unload(): Promise<void>;
}
//# sourceMappingURL=PluginSandbox.d.ts.map