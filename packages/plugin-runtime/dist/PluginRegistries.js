// Implémentations des registres du plugin API.
// Séparées des types (plugin-api) pour garder le package plugin-api sans code runtime.
// ─── TriggerRegistryImpl ──────────────────────────────────────────────────
export class TriggerRegistryImpl {
    triggers = new Map();
    register(trigger) {
        const conflict = this.findConflict(trigger.character);
        if (conflict && conflict.id !== trigger.id) {
            console.warn(`[TriggerRegistry] Conflict: "${trigger.character}" is already claimed by "${conflict.id}". ` +
                `Plugin "${trigger.id}" may not work as expected.`);
        }
        this.triggers.set(trigger.id, trigger);
    }
    unregister(id) {
        this.triggers.delete(id);
    }
    getAll() {
        return [...this.triggers.values()];
    }
    findConflict(character) {
        for (const t of this.triggers.values()) {
            if (t.character === character)
                return t;
        }
        return undefined;
    }
}
export class BlockRegistryImpl {
    slashRegistry;
    // see ADR-012
    specEntries = new Map();
    // Set by PluginLoader before calling plugin.onload() when tag=true.
    // Any spec registered while this is set gets stamped with this plugin id.
    _currentPluginId;
    constructor(slashRegistry) {
        this.slashRegistry = slashRegistry;
    }
    register(spec) {
        const pluginId = this._currentPluginId;
        this.specEntries.set(spec.type, { spec, pluginId });
        console.debug(`[BlockRegistry] registered: ${spec.type}${pluginId ? ` (${pluginId})` : ''}`);
        if (spec.trigger && this.slashRegistry) {
            const triggers = Array.isArray(spec.trigger) ? spec.trigger : [spec.trigger];
            for (const t of triggers) {
                this.slashRegistry.register({
                    id: t.id, label: t.label, description: t.description,
                    icon: t.icon, category: t.category, insert: t.insert,
                });
            }
        }
    }
    unregister(type) {
        const entry = this.specEntries.get(type);
        if (entry?.spec.trigger && this.slashRegistry) {
            const triggers = Array.isArray(entry.spec.trigger) ? entry.spec.trigger : [entry.spec.trigger];
            for (const t of triggers)
                this.slashRegistry.unregister(t.id);
        }
        this.specEntries.delete(type);
    }
    detectBlock(text) {
        return this.detectActive(text, null);
    }
    // see ADR-012
    detectActive(text, ids) {
        for (const [type, { spec, pluginId }] of this.specEntries) {
            if (!spec.detect)
                continue;
            if (ids !== null && !ids.has(pluginId ?? ''))
                continue;
            const matched = spec.detect instanceof RegExp ? spec.detect.test(text) : spec.detect(text);
            if (matched)
                return { type, spec };
        }
        return null;
    }
    getAll() {
        return [...this.specEntries.values()].map(e => e.spec);
    }
    getActive(ids) {
        if (ids === null)
            return this.getAll();
        return [...this.specEntries.values()]
            .filter(e => ids.has(e.pluginId ?? ''))
            .map(e => e.spec);
    }
}
export class HookRegistryImpl {
    beforeParseHooks = [];
    afterParseHooks = [];
    beforeRenderHooks = [];
    afterRenderHooks = [];
    documentOpenHooks = [];
    documentSaveHooks = [];
    selectionChangeHooks = [];
    documentStabilizedHooks = [];
    beforeParse(hook) { this.beforeParseHooks.push(hook); }
    afterParse(hook) { this.afterParseHooks.push(hook); }
    beforeRender(hook) { this.beforeRenderHooks.push(hook); }
    afterRender(hook) { this.afterRenderHooks.push(hook); }
    onDocumentOpen(hook) { this.documentOpenHooks.push(hook); }
    onDocumentSave(hook) { this.documentSaveHooks.push(hook); }
    onSelectionChange(hook) { this.selectionChangeHooks.push(hook); }
    onDocumentStabilized(hook) { this.documentStabilizedHooks.push(hook); }
    async runBeforeParse(source) {
        let s = source;
        for (const h of this.beforeParseHooks)
            s = await h(s);
        return s;
    }
    runBeforeParseSync(source) {
        let s = source;
        for (const h of this.beforeParseHooks) {
            const result = h(s);
            // Skip async hooks — only sync string returns are applied in the CM6 StateField
            if (typeof result === 'string')
                s = result;
        }
        return s;
    }
    async runAfterRender(html) {
        let h = html;
        for (const hook of this.afterRenderHooks)
            h = await hook(h);
        return h;
    }
    runDocumentOpen(path) {
        this.documentOpenHooks.forEach(h => h(path));
    }
    runDocumentSave(content) {
        this.documentSaveHooks.forEach(h => h(content));
    }
    runDocumentStabilized(docId, path, content) {
        this.documentStabilizedHooks.forEach(h => h(docId, path, content));
    }
}
// ─── IndexRegistryImpl ────────────────────────────────────────────────────
export class IndexRegistryImpl {
    contributors = new Map();
    register(contributor) {
        this.contributors.set(contributor.namespace, contributor);
        console.debug(`[IndexRegistry] registered contributor: ${contributor.namespace}`);
    }
    getAll() {
        return [...this.contributors.values()];
    }
    get(namespace) {
        return this.contributors.get(namespace);
    }
}
// ─── CommandRegistryImpl ──────────────────────────────────────────────────
export class CommandRegistryImpl {
    commands = new Map();
    register(command) {
        this.commands.set(command.id, command);
    }
    unregister(id) {
        this.commands.delete(id);
    }
    execute(id, context) {
        const cmd = this.commands.get(id);
        if (!cmd) {
            console.warn(`[CommandRegistry] unknown command: ${id}`);
            return;
        }
        cmd.run(context);
    }
    getAll() {
        return [...this.commands.values()];
    }
}
// ─── FileTypeRegistryImpl ─────────────────────────────────────────────────
export class FileTypeRegistryImpl {
    specs = new Map();
    register(spec) { this.specs.set(spec.extension, spec); }
    unregister(ext) { this.specs.delete(ext); }
    resolve(ext) { return this.specs.get(ext); }
}
// ─── VaultAPIStub ─────────────────────────────────────────────────────────
// No-op implementation for editor-dev (offline). Replace with a real
// implementation when the server is available.
export class VaultAPIStub {
    async read(_documentId) { return ''; }
    async readDocumentByPath(_path) { return ''; }
    async write(_documentId, _content) { }
    async list(_dir) { return []; }
    async exists(_documentId) { return false; }
    resolveDocumentId(_path) { return undefined; }
}
export class WorkspaceAPIStub {
    async openFile(_path) { }
    openPanel(_panelId) { }
    closePanel(_panelId) { }
    getActiveDocument() { return undefined; }
}
// ─── SlashRegistryImpl ────────────────────────────────────────────────────
export class SlashRegistryImpl {
    items = new Map();
    register(item) {
        this.items.set(item.id, item);
    }
    unregister(id) {
        this.items.delete(id);
    }
    getAll() {
        return [...this.items.values()];
    }
}
// ─── ViewRegistryStub ─────────────────────────────────────────────────────
// No-op for contexts where no workspace is available (e.g. editor-only mode).
export class ViewRegistryStub {
    register(_spec) { }
    unregister(_id) { }
    getAll() { return []; }
}
// ─── ToolbarCommandRegistryImpl ───────────────────────────────────────────
export class ToolbarCommandRegistryImpl {
    cmds = new Map();
    register(cmd) { this.cmds.set(cmd.id, cmd); }
    unregister(id) { this.cmds.delete(id); }
    getAll() { return Array.from(this.cmds.values()); }
    getByGroup(group) { return this.getAll().filter(c => c.group === group); }
}
// ─── EditorPositionAPIStub ────────────────────────────────────────────────
// No-op stub used before EditorCore wires the real implementation.
export class EditorPositionAPIStub {
    getCursorCoords() { return null; }
    getSelectionCoords() { return null; }
    getSelectionText() { return ''; }
}
// ─── PluginAPIImpl ────────────────────────────────────────────────────────
export class PluginAPIImpl {
    blocks;
    hooks;
    commands;
    files;
    vault;
    workspace;
    views;
    slash;
    triggers;
    toolbar;
    sync;
    index;
    editor;
    constructor(blocks, hooks, commands, files, vault, workspace, views, slash, triggers, toolbar, editor, sync, index) {
        this.blocks = blocks;
        this.hooks = hooks;
        this.commands = commands;
        this.files = files;
        this.vault = vault;
        this.workspace = workspace;
        this.views = views;
        this.slash = slash;
        this.triggers = triggers;
        this.toolbar = toolbar;
        this.sync = sync;
        this.index = index;
        this.editor = editor ?? new EditorPositionAPIStub();
    }
    /** Called by EditorCore after the view is created to wire in the real position API. */
    setEditorPositionAPI(api) {
        this.editor = api;
    }
    static create(vault, sync) {
        const slash = new SlashRegistryImpl();
        const triggers = new TriggerRegistryImpl();
        return new PluginAPIImpl(new BlockRegistryImpl(slash), new HookRegistryImpl(), new CommandRegistryImpl(), new FileTypeRegistryImpl(), vault ?? new VaultAPIStub(), new WorkspaceAPIStub(), new ViewRegistryStub(), slash, triggers, new ToolbarCommandRegistryImpl(), undefined, sync, new IndexRegistryImpl());
    }
}
//# sourceMappingURL=PluginRegistries.js.map