import type { PluginAPI, PluginPermission } from '@poc/plugin-api';
export declare class PermissionFilteredAPI implements PluginAPI {
    private inner;
    private permissions;
    constructor(inner: PluginAPI, permissions: Set<PluginPermission>);
    get commands(): import("@poc/plugin-api").IPluginCommandsAPI;
    get hooks(): import("@poc/plugin-api").IPluginHooksAPI;
    get blocks(): import("@poc/plugin-api").IPluginBlocksAPI;
    get files(): import("@poc/plugin-api").FileTypeRegistry;
    get vault(): import("@poc/plugin-api").IPluginVaultAPI;
    get views(): import("@poc/plugin-api").IPluginViewsAPI;
    get workspace(): import("@poc/plugin-api").IPluginWorkspaceAPI;
    get slash(): import("@poc/plugin-api").IPluginSlashAPI;
    get triggers(): import("@poc/plugin-api").IPluginTriggersAPI;
    get editor(): import("@poc/plugin-api").IPluginEditorAPI;
    get toolbar(): import("@poc/plugin-api").IPluginToolbarAPI;
    private require;
}
//# sourceMappingURL=PermissionFilteredAPI.d.ts.map