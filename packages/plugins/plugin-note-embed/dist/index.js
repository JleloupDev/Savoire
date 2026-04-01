import { marked } from 'marked';
const FULL_EMBED_RE = /^\s*!\[\[([^\]]+)\]\]\s*$/;
// Parse YAML-ish frontmatter to strip it before rendering
function parseFrontmatter(source) {
    const match = source.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
    return { body: match ? match[1] : source };
}
function parseEmbedTarget(raw) {
    const source = raw.trim();
    const noAlias = source.split('|', 1)[0].trim();
    const noHeading = noAlias.split('#', 1)[0].trim();
    return { raw: source, targetPath: noHeading };
}
function parseEmbedBlock(blockText) {
    const match = String(blockText).match(FULL_EMBED_RE);
    if (!match)
        return null;
    return parseEmbedTarget(match[1]);
}
function normalizeEmbedData(input) {
    if (typeof input === 'string') {
        return parseEmbedBlock(input) ?? parseEmbedTarget(input);
    }
    if (input && typeof input === 'object') {
        const raw = 'raw' in input && typeof input.raw === 'string' ? input.raw : '';
        const targetPath = 'targetPath' in input && typeof input.targetPath === 'string'
            ? input.targetPath
            : parseEmbedTarget(raw).targetPath;
        return { raw, targetPath };
    }
    return { raw: '', targetPath: '' };
}
const plugin = {
    manifest: {
        id: 'plugin-note-embed',
        name: 'Note Embeds',
        version: '1.0.0',
        permissions: ['ui:editor', 'vault:read'],
    },
    async onload(api) {
        api.triggers.register({ id: 'note-embed', character: '![[', description: 'Note embed lecture seule' });
        api.blocks.register({
            type: 'note-embed',
            trigger: {
                id: 'note-embed',
                label: 'Intégrer une note',
                description: 'Embed lecture seule ![[...]]',
                icon: '📄',
                category: 'Embeds',
                insert: '![[chemin/fichier.md]]',
            },
            // K1 — read-only embed: ![[filename]]
            detect: (text) => parseEmbedBlock(text) !== null,
            deserialize(raw) {
                return parseEmbedBlock(String(raw)) ?? parseEmbedTarget('');
            },
            serialize(data) {
                const embed = normalizeEmbedData(data);
                return `![[${embed.raw}]]`;
            },
            createEditorWidget: (_data, _ctx) => ({
                mount: (_el) => { },
                destroy: () => { },
            }),
            renderClient(data, _ctx) {
                const { raw, targetPath } = normalizeEmbedData(data);
                const container = document.createElement('div');
                container.className = 'note-embed';
                container.style.cssText =
                    'border:1px solid #dddcd5;border-radius:6px;padding:10px 14px;margin:6px 0;background:#fafaf8';
                const header = document.createElement('div');
                header.className = 'note-embed-header';
                header.style.cssText =
                    'font-size:11px;color:#aaa;margin-bottom:6px;display:flex;align-items:center;gap:6px';
                header.innerHTML = `<span>📄</span><span>${raw}</span>`;
                container.appendChild(header);
                const body = document.createElement('div');
                body.className = 'note-embed-body';
                body.style.cssText = 'font-size:13px';
                body.textContent = 'Loading…';
                container.appendChild(body);
                // K1: read-only markdown preview
                if (!targetPath) {
                    body.textContent = '⚠ Invalid embed path';
                    return container;
                }
                api.vault.readDocumentByPath(targetPath).then((source) => {
                    const { body: mdBody } = parseFrontmatter(source);
                    const html = String(marked.parse(mdBody));
                    body.innerHTML = html;
                }).catch(() => {
                    body.textContent = `⚠ Could not load "${targetPath}"`;
                });
                return container;
            },
        });
    },
    async onunload() { },
};
export default plugin;
//# sourceMappingURL=index.js.map