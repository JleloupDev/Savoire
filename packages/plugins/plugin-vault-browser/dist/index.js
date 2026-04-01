import { VaultBrowserWidget } from './VaultBrowserWidget';
export function createVaultBrowserPlugin(options) {
    const viewId = options.viewId ?? 'vault-browser';
    const title = options.title ?? 'Vaults';
    const container = options.container ?? 'left';
    const initialSize = options.initialSize ?? 260;
    return {
        manifest: {
            id: 'plugin-vault-browser',
            name: 'Vault Browser',
            version: '0.0.1',
            description: 'Sidebar vault browser view',
            permissions: ['ui:editor'],
        },
        async onload(api) {
            api.views.register({
                id: viewId,
                title,
                container,
                initialSize,
                tabOf: options.tabOf,
                belowOf: options.belowOf,
                closable: options.closable,
                createView(ctx) {
                    return new VaultBrowserWidget(ctx.workspace, options.refs);
                },
            });
        },
        async onunload() { },
    };
}
export { VaultBrowserWidget } from './VaultBrowserWidget';
//# sourceMappingURL=index.js.map