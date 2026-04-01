import { MetadataWidget } from './MetadataWidget';
export function createMetadataPlugin(options = {}) {
    return {
        manifest: {
            id: 'plugin-metadata',
            name: 'Métadonnées',
            version: '0.0.1',
            description: 'Affiche les métadonnées indexées du document courant.',
            permissions: ['vault:read', 'ui:editor'],
        },
        async onload(api) {
            api.views.register({
                id: 'metadata',
                title: 'Métadonnées',
                icon: 'tag',
                container: 'right',
                tabOf: options.tabOf,
                initialSize: 280,
                closable: true,
                createView(ctx) {
                    return new MetadataWidget(ctx, api.vault);
                },
            });
        },
        async onunload() { },
    };
}
export { MetadataWidget } from './MetadataWidget';
//# sourceMappingURL=index.js.map