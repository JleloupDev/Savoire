import type { PluginManifest } from './manifest';
import type { VaultAPI } from './vault';
import type { WorkspaceAPI } from './workspace';
import type { CommandRegistry } from './commands';
import type { HookRegistry } from './hooks';
import type { BlockRegistry } from './blocks';
import type { FileTypeRegistry } from './files';
import type { ViewRegistry } from './views';
import type { SlashRegistry, TriggerRegistry } from './triggers';
import type { EditorPositionAPI, ToolbarCommandRegistry } from './editor';
import type { SyncAPI } from './sync';
import type { IPluginIndexAPI } from './indexing';
export interface IPluginVaultAPI extends VaultAPI {
}
export interface IPluginWorkspaceAPI extends WorkspaceAPI {
}
export interface IPluginCommandsAPI extends CommandRegistry {
}
export interface IPluginViewsAPI extends ViewRegistry {
}
export interface IPluginBlocksAPI extends BlockRegistry {
}
export interface IPluginHooksAPI extends HookRegistry {
}
export interface IPluginSlashAPI extends SlashRegistry {
}
export interface IPluginTriggersAPI extends TriggerRegistry {
}
export interface IPluginEditorAPI extends EditorPositionAPI {
}
export interface IPluginToolbarAPI extends ToolbarCommandRegistry {
}
export interface IPluginAPI {
    commands: IPluginCommandsAPI;
    hooks: IPluginHooksAPI;
    blocks: IPluginBlocksAPI;
    files: FileTypeRegistry;
    vault: IPluginVaultAPI;
    workspace: IPluginWorkspaceAPI;
    views: IPluginViewsAPI;
    slash: IPluginSlashAPI;
    triggers: IPluginTriggersAPI;
    editor: IPluginEditorAPI;
    toolbar: IPluginToolbarAPI;
    /** Sync temps réel format-agnostic (DocumentRoom / /hubs/room). Absent si non configuré. */
    sync?: SyncAPI;
    /** Index local — enregistrement de contributeurs (backlinks, tags…). */
    index?: IPluginIndexAPI;
}
export interface PluginAPI extends IPluginAPI {
}
export interface VaultPlugin {
    manifest: PluginManifest;
    onload(api: PluginAPI): Promise<void>;
    onunload(): Promise<void>;
}
export interface IEditorHostAPI extends PluginAPI {
    /** Post-construction wiring: EditorCore registers itself as the cursor/selection provider. */
    setEditorPositionAPI(api: EditorPositionAPI): void;
}
export interface IPluginLoader {
    loadInternal(plugin: VaultPlugin, api: PluginAPI): Promise<void>;
    getLoadedIds(): string[];
}
//# sourceMappingURL=plugin-api.d.ts.map