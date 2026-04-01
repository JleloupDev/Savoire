import { GraphIndexContributor } from './GraphIndexContributor';
import { GraphWidget } from './GraphWidget';
export function createGraphPlugin(options = {}) {
    const contributor = new GraphIndexContributor();
    const plugin = {
        manifest: {
            id: 'plugin-graph',
            name: 'Graphe de notes',
            version: '0.0.1',
            description: 'Visualise les dépendances entre notes via les wikilinks.',
            permissions: ['vault:read', 'ui:editor'],
        },
        async onload(api) {
            // Register the index contributor so it receives onOp events
            api.index?.register(contributor);
            api.views.register({
                id: 'graph',
                title: 'Graphe',
                icon: 'git-fork',
                container: 'right',
                tabOf: options.tabOf,
                initialSize: 320,
                closable: true,
                createView(ctx) {
                    return new GraphWidget(ctx, contributor);
                },
            });
        },
        async onunload() { },
    };
    return { plugin, contributor };
}
export { GraphIndexContributor } from './GraphIndexContributor';
//# sourceMappingURL=index.js.map