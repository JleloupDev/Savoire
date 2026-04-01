export type PluginLoadStrategy = 'auto' | 'lazy';
export interface NotePluginScope {
    /** Plugin id as declared in its manifest. */
    id: string;
    /** Load strategy for this note. Default: 'auto'. */
    load?: PluginLoadStrategy;
}
export interface NoteScope {
    /** Plugins activated for this note. Merged on top of the editor's built-ins. */
    plugins?: NotePluginScope[];
}
export interface PluginManifest {
    id: string;
    name: string;
    version: string;
    description?: string;
    author?: string;
    permissions?: PluginPermission[];
    /**
     * When true, this plugin is active for every note by default (no frontmatter needed).
     * When false/absent, the plugin is only active when the note explicitly activates it
     * (via frontmatter `plugins:` or file extension matching).
     */
    defaultActive?: boolean;
}
export type PluginPermission = 'vault:read' | 'vault:write' | 'network:*' | 'ui:editor' | 'ui:settings';
//# sourceMappingURL=manifest.d.ts.map