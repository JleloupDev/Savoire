import { PermissionFilteredAPI } from './PermissionFilteredAPI';
// see ADR-014
export class PluginSandbox {
    plugin = null;
    blobUrl = null;
    async load(code, api) {
        // Wrap in a module that receives the filtered API as an import
        const wrappedCode = `
      const __api__ = globalThis.__pluginAPI__
      ${code}
    `;
        const blob = new Blob([wrappedCode], { type: 'application/javascript' });
        this.blobUrl = URL.createObjectURL(blob);
        const permissions = new Set();
        (await import(/* @vite-ignore */ this.blobUrl));
        // After dynamic import — clean up blob URL
        URL.revokeObjectURL(this.blobUrl);
        this.blobUrl = null;
        // The plugin module must set globalThis.__poc_plugin__
        const pluginExport = globalThis.__poc_plugin__;
        if (!pluginExport) {
            throw new Error('[PluginSandbox] Plugin did not export via globalThis.__poc_plugin__');
        }
        this.plugin = pluginExport;
        pluginExport.manifest.permissions?.forEach((p) => permissions.add(p));
        const filteredAPI = new PermissionFilteredAPI(api, permissions);
        await pluginExport.onload(filteredAPI);
        console.log(`[PluginSandbox] Loaded plugin: ${pluginExport.manifest.id}`);
    }
    async unload() {
        if (this.plugin) {
            await this.plugin.onunload();
            this.plugin = null;
        }
    }
}
//# sourceMappingURL=PluginSandbox.js.map