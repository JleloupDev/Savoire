// plugin-wikilinks: transforms [[Page Name]] links into navigable anchors.
// Negative lookbehind for "!" so that ![[...]] embeds (handled by plugin-note-embed) are not touched.
const WIKILINK_RE = /(?<!!)(\[\[([^\]]+)\]\])/g;
const plugin = {
    manifest: {
        id: 'plugin-wikilinks',
        name: 'Wiki Links',
        version: '0.0.1',
        permissions: ['ui:editor', 'vault:read'],
    },
    async onload(api) {
        api.triggers.register({ id: 'wikilinks', character: '[[', description: 'Lien wiki [[Page]]' });
        api.hooks.beforeParse((source) => {
            // Replace [[Target]] with a standard markdown link for now.
            // The full implementation would resolve vault paths.
            // _outer = [[Target]], target = Target (inner capture group)
            return source.replace(WIKILINK_RE, (_m, _outer, target) => `[${target}](#${target})`);
        });
    },
    async onunload() { },
};
export default plugin;
//# sourceMappingURL=index.js.map