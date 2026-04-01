// see ADR-013
export class PermissionFilteredAPI {
    inner;
    permissions;
    constructor(inner, permissions) {
        this.inner = inner;
        this.permissions = permissions;
    }
    get commands() {
        this.require('ui:editor');
        return this.inner.commands;
    }
    get hooks() {
        this.require('ui:editor');
        return this.inner.hooks;
    }
    get blocks() {
        this.require('ui:editor');
        return this.inner.blocks;
    }
    get files() {
        this.require('ui:editor');
        return this.inner.files;
    }
    get vault() {
        // vault:read is the minimum — vault:write is checked per-operation
        this.require('vault:read');
        return this.inner.vault;
    }
    get views() {
        this.require('ui:editor');
        return this.inner.views;
    }
    get workspace() {
        this.require('ui:editor');
        return this.inner.workspace;
    }
    get slash() {
        this.require('ui:editor');
        return this.inner.slash;
    }
    get triggers() {
        this.require('ui:editor');
        return this.inner.triggers;
    }
    get editor() {
        this.require('ui:editor');
        return this.inner.editor;
    }
    get toolbar() {
        this.require('ui:editor');
        return this.inner.toolbar;
    }
    require(permission) {
        if (!this.permissions.has(permission)) {
            throw new Error(`[PluginRuntime] Permission denied: '${permission}'. ` +
                `Declare it in the plugin manifest.`);
        }
    }
}
//# sourceMappingURL=PermissionFilteredAPI.js.map