import { BacklinksIndexContributor } from './BacklinksIndexContributor';
import { BacklinksWidget } from './BacklinksWidget';
export function createBacklinksPlugin(options = {}) {
    const contributor = new BacklinksIndexContributor();
    return {
        manifest: {
            id: 'plugin-backlinks',
            name: 'Backlinks',
            version: '0.0.1',
            description: 'Affiche les documents qui pointent vers le document courant.',
            permissions: ['vault:read', 'ui:editor'],
        },
        async onload(api) {
            // Enregistre le contributeur dans l'index local
            api.index?.register(contributor);
            api.views.register({
                id: 'backlinks',
                title: 'Backlinks',
                icon: 'link',
                container: 'right',
                tabOf: options.tabOf,
                initialSize: options.initialSize ?? 280,
                closable: true,
                createView(ctx) {
                    return new BacklinksWidget(ctx, contributor);
                },
            });
        },
        async onunload() { },
    };
}
export { BacklinksWidget } from './BacklinksWidget';
export { BacklinksIndexContributor } from './BacklinksIndexContributor';
//# sourceMappingURL=index.js.map