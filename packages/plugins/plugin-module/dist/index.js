import { marked } from 'marked';
const MODULE_FRONTMATTER = '---\ntype: module\n---\n';
function parseFrontmatter(source) {
    const match = source.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!match)
        return { meta: {}, body: source };
    const meta = {};
    for (const line of match[1].split('\n')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx > 0) {
            meta[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim();
        }
    }
    return { meta, body: match[2] };
}
const plugin = {
    manifest: {
        id: 'plugin-module',
        name: 'Modules',
        version: '1.0.0',
        permissions: ['ui:editor', 'vault:read', 'vault:write'],
    },
    async onload(api) {
        api.triggers.register({ id: 'module', character: '@[[', description: 'Module embed éditable' });
        // ── K2 block: @[[module.md]] ────────────────────────────────────────────
        api.blocks.register({
            type: 'module',
            trigger: {
                id: 'module-embed',
                label: 'Module',
                description: 'Intégrer un module éditable @[[...]]',
                icon: '🧩',
                category: 'Embeds',
                insert: '@[[chemin/fichier.md]]',
            },
            // @[[...]] syntax — distinct from ![[...]] (K1 read-only)
            detect: /@\[\[(.+?)\]\]/,
            deserialize(raw) {
                const match = String(raw).match(/@\[\[(.+?)\]\]/);
                return { path: match?.[1] ?? '' };
            },
            serialize(data) {
                return `@[[${data.path}]]`;
            },
            createEditorWidget: (_data, _ctx) => ({
                mount: (_el) => { },
                destroy: () => { },
            }),
            renderClient(data, _ctx) {
                const { path } = data;
                const container = document.createElement('div');
                container.className = 'module-embed';
                container.style.cssText =
                    'border:1px solid #a855f7;border-radius:6px;padding:10px 14px;margin:6px 0;background:#faf5ff';
                // ── Header ────────────────────────────────────────────────────────────
                const header = document.createElement('div');
                header.style.cssText =
                    'font-size:11px;color:#7c3aed;margin-bottom:6px;display:flex;align-items:center;gap:6px';
                const editBtn = document.createElement('button');
                editBtn.textContent = 'Edit';
                editBtn.style.cssText =
                    'margin-left:auto;background:#a855f7;color:#fff;font-size:10px;padding:1px 8px;' +
                        'border-radius:10px;border:none;cursor:pointer;font-family:inherit';
                header.innerHTML = `<span>🧩</span><span>${path}</span>`;
                header.appendChild(Object.assign(document.createElement('span'), {
                    style: 'margin-left:auto',
                }));
                header.appendChild(editBtn);
                container.appendChild(header);
                // ── Preview (default view) ────────────────────────────────────────────
                const preview = document.createElement('div');
                preview.className = 'module-preview';
                preview.style.cssText = 'font-size:13px;line-height:1.5;color:inherit';
                preview.textContent = 'Loading…';
                container.appendChild(preview);
                // ── Editor (hidden by default) ────────────────────────────────────────
                const ta = document.createElement('textarea');
                ta.className = 'module-editor';
                ta.style.cssText =
                    'display:none;width:100%;min-height:100px;box-sizing:border-box;border:none;background:transparent;' +
                        'resize:vertical;font-family:inherit;font-size:13px;line-height:1.5;outline:none;padding:0;color:inherit';
                container.appendChild(ta);
                let body = '';
                const renderPreview = (md) => {
                    preview.innerHTML = String(marked.parse(md));
                };
                // Load content (strip frontmatter)
                api.vault.readDocumentByPath(path).then((source) => {
                    body = parseFrontmatter(source).body;
                    renderPreview(body);
                    ta.value = body;
                }).catch(() => {
                    preview.textContent = `⚠ Could not load "${path}"`;
                    editBtn.disabled = true;
                });
                // Prevent CM from reclaiming focus and showing raw @[[...]] source
                container.addEventListener('mousedown', (e) => e.stopPropagation());
                container.addEventListener('click', (e) => e.stopPropagation());
                // ── Toggle edit / preview ─────────────────────────────────────────────
                editBtn.addEventListener('click', () => {
                    const editing = ta.style.display !== 'none';
                    if (editing) {
                        // save & return to preview
                        body = ta.value;
                        renderPreview(body);
                        const docId = api.vault.resolveDocumentId(path);
                        if (!docId) {
                            console.error(`[plugin-module] Document not found for path: ${path}`);
                            return;
                        }
                        api.vault.write(docId, MODULE_FRONTMATTER + body).catch(console.error);
                        ta.style.display = 'none';
                        preview.style.display = '';
                        editBtn.textContent = 'Edit';
                    }
                    else {
                        ta.value = body;
                        preview.style.display = 'none';
                        ta.style.display = '';
                        ta.focus();
                        editBtn.textContent = 'Save';
                    }
                });
                return container;
            },
        });
        // ── beforeParse: strip frontmatter from module documents ────────────────
        api.hooks.beforeParse((source) => {
            const { meta, body } = parseFrontmatter(source);
            if (!meta['type'])
                return source;
            if (meta['type'] === 'module') {
                const banner = `<div class="module-banner" style="` +
                    `background:#f3e8ff;border-left:3px solid #a855f7;` +
                    `padding:4px 10px;border-radius:0 4px 4px 0;` +
                    `font-size:11px;color:#7c3aed;margin-bottom:10px">` +
                    `🧩 Module document` +
                    `</div>\n\n`;
                return banner + body;
            }
            return body;
        });
        api.commands.register({
            id: 'module:create',
            label: 'Create Module',
            run: (_ctx) => {
                console.log('[plugin-module] module:create');
            },
        });
    },
    async onunload() { },
};
export default plugin;
//# sourceMappingURL=index.js.map