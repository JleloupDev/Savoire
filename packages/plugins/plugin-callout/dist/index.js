// plugin-callout: renders > [!NOTE] callout blocks.
const plugin = {
    manifest: {
        id: 'plugin-callout',
        name: 'Callout Blocks',
        version: '0.0.1',
        permissions: ['ui:editor'],
        defaultActive: true,
    },
    async onload(api) {
        api.triggers.register({ id: 'callout', character: '> [!', description: 'Callout block (> [!TYPE])' });
        api.blocks.register({
            type: 'callout',
            trigger: [
                { id: 'callout-note', label: 'Callout Note', description: '> [!NOTE] bloc info', icon: 'ℹ', category: 'Callouts', insert: '> [!NOTE]\n> ' },
                { id: 'callout-info', label: 'Callout Info', description: '> [!INFO] information', icon: 'ℹ', category: 'Callouts', insert: '> [!INFO]\n> ' },
                { id: 'callout-tip', label: 'Callout Tip', description: '> [!TIP] conseil', icon: '💡', category: 'Callouts', insert: '> [!TIP]\n> ' },
                { id: 'callout-success', label: 'Callout Success', description: '> [!SUCCESS] succès', icon: '✔', category: 'Callouts', insert: '> [!SUCCESS]\n> ' },
                { id: 'callout-warning', label: 'Callout Warning', description: '> [!WARNING] avertissement', icon: '⚠', category: 'Callouts', insert: '> [!WARNING]\n> ' },
                { id: 'callout-caution', label: 'Callout Caution', description: '> [!CAUTION] attention', icon: '⚠', category: 'Callouts', insert: '> [!CAUTION]\n> ' },
                { id: 'callout-danger', label: 'Callout Danger', description: '> [!DANGER] danger', icon: '🔥', category: 'Callouts', insert: '> [!DANGER]\n> ' },
                { id: 'callout-bug', label: 'Callout Bug', description: '> [!BUG] bug', icon: '🐛', category: 'Callouts', insert: '> [!BUG]\n> ' },
                { id: 'callout-todo', label: 'Callout Todo', description: '> [!TODO] à faire', icon: '✅', category: 'Callouts', insert: '> [!TODO]\n> ' },
                { id: 'callout-question', label: 'Callout Question', description: '> [!QUESTION] question', icon: '❓', category: 'Callouts', insert: '> [!QUESTION]\n> ' },
            ],
            detect: /^>\s*\[!\w+\]/,
            serialize: (data) => {
                const d = data;
                const lines = d.content.split('\n').map(l => `> ${l}`);
                return `> [!${d.type.toUpperCase()}]\n${lines.join('\n')}`;
            },
            deserialize: (raw) => {
                const match = String(raw).match(/\[!(\w+)\]/);
                const content = String(raw)
                    .split('\n')
                    .slice(1) // drop the [!TYPE] line
                    .map(l => l.replace(/^>\s?/, '')) // strip "> " prefix
                    .join('\n')
                    .trim();
                return { type: (match?.[1] ?? 'NOTE').toUpperCase(), content };
            },
            createEditorWidget: (_data, _ctx) => ({
                mount: (_el) => { },
                destroy: () => { },
            }),
            renderClient: (data, _ctx) => {
                const d = data;
                const COLORS = {
                    NOTE: { border: '#3b82f6', bg: 'rgba(59,130,246,0.08)', icon: 'ℹ' },
                    INFO: { border: '#3b82f6', bg: 'rgba(59,130,246,0.08)', icon: 'ℹ' },
                    TIP: { border: '#22c55e', bg: 'rgba(34,197,94,0.08)', icon: '💡' },
                    SUCCESS: { border: '#22c55e', bg: 'rgba(34,197,94,0.08)', icon: '✔' },
                    WARNING: { border: '#f59e0b', bg: 'rgba(245,158,11,0.08)', icon: '⚠' },
                    CAUTION: { border: '#f59e0b', bg: 'rgba(245,158,11,0.08)', icon: '⚠' },
                    DANGER: { border: '#ef4444', bg: 'rgba(239,68,68,0.08)', icon: '🔥' },
                    BUG: { border: '#ef4444', bg: 'rgba(239,68,68,0.08)', icon: '🐛' },
                    TODO: { border: '#a855f7', bg: 'rgba(168,85,247,0.08)', icon: '✅' },
                    QUESTION: { border: '#06b6d4', bg: 'rgba(6,182,212,0.08)', icon: '❓' },
                };
                const DEFAULT = { border: '#3b82f6', bg: 'rgba(59,130,246,0.08)', icon: 'ℹ' };
                const style = COLORS[d.type] ?? DEFAULT;
                const el = document.createElement('div');
                el.className = `callout callout-${d.type.toLowerCase()}`;
                el.style.cssText = `border-left:4px solid ${style.border};background:${style.bg};border-radius:4px;padding:8px 12px;margin:4px 0`;
                const title = document.createElement('div');
                title.className = 'callout-title';
                title.style.cssText = `font-weight:600;color:${style.border};margin-bottom:4px`;
                title.textContent = `${style.icon} ${d.type.charAt(0) + d.type.slice(1).toLowerCase()}`;
                const body = document.createElement('div');
                body.className = 'callout-body';
                body.style.cssText = 'color:inherit';
                body.textContent = d.content;
                el.appendChild(title);
                el.appendChild(body);
                return el;
            },
        });
    },
    async onunload() { },
};
export default plugin;
//# sourceMappingURL=index.js.map