import { FileTreeWidget } from './FileTreeWidget';
export function createFileTreePlugin(options = {}) {
    const viewId = options.viewId ?? 'filetree';
    const title = options.title ?? 'Explorer';
    const icon = options.icon ?? 'folder';
    const container = options.container ?? 'left';
    return {
        manifest: {
            id: 'plugin-filetree',
            name: 'File Explorer',
            version: '0.0.1',
            description: 'Sidebar file tree view',
            permissions: ['vault:read', 'ui:editor'],
        },
        async onload(api) {
            api.views.register({
                id: viewId,
                title,
                icon,
                container,
                tabOf: options.tabOf,
                belowOf: options.belowOf,
                closable: options.closable,
                initialSize: options.initialSize,
                createView(ctx) {
                    return new FileTreeWidget(ctx);
                },
            });
        },
        async onunload() { },
    };
}
const plugin = createFileTreePlugin();
export default plugin;
export { FileTreeWidget } from './FileTreeWidget';
export { FileTree } from './FileTreeWidget';
//# sourceMappingURL=index.js.map