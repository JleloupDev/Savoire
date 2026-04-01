import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import csharp from 'highlight.js/lib/languages/csharp';
import sql from 'highlight.js/lib/languages/sql';
import rust from 'highlight.js/lib/languages/rust';
import go from 'highlight.js/lib/languages/go';
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('json', json);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('csharp', csharp);
hljs.registerLanguage('cs', csharp);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('rs', rust);
hljs.registerLanguage('go', go);
// Catppuccin Mocha theme — injecté une seule fois dans le document.
const STYLE_ID = 'poc-hljs-theme';
function injectTheme() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID))
        return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
    .hljs { background: transparent; color: #cdd6f4; }
    .hljs-keyword, .hljs-selector-tag { color: #cba6f7; }
    .hljs-string, .hljs-attr { color: #a6e3a1; }
    .hljs-number, .hljs-literal { color: #fab387; }
    .hljs-comment { color: #6c7086; font-style: italic; }
    .hljs-function, .hljs-title { color: #89b4fa; }
    .hljs-class, .hljs-title.class_ { color: #f9e2af; }
    .hljs-built_in { color: #89dceb; }
    .hljs-type { color: #f9e2af; }
    .hljs-variable, .hljs-name { color: #cdd6f4; }
    .hljs-tag { color: #cba6f7; }
    .hljs-operator, .hljs-punctuation { color: #89dceb; }
    .hljs-meta { color: #6c7086; }
    .hljs-section { color: #89b4fa; font-weight: bold; }
    .hljs-addition { color: #a6e3a1; background: rgba(166,227,161,0.08); }
    .hljs-deletion { color: #f38ba8; background: rgba(243,139,168,0.08); }
    .hljs-params { color: #fab387; }
    .hljs-property { color: #89b4fa; }
    .hljs-selector-class { color: #f9e2af; }
    .hljs-selector-id { color: #f38ba8; }
  `;
    document.head.appendChild(style);
}
const FENCE_RE = /^```(\w*)\n?([\s\S]*?)\n?```\s*$/;
// DECISION: languages that have a dedicated plugin registered before code-block
// in the load order (e.g. mermaid) OR after it (e.g. table via note-scope).
// code-block is a catch-all — it must yield to more specific handlers.
const DEDICATED_LANGS = new Set(['mermaid', 'table']);
const plugin = {
    manifest: {
        id: 'plugin-code-block',
        name: 'Code Block',
        version: '1.0.0',
        permissions: ['ui:editor'],
        defaultActive: true,
    },
    async onload(api) {
        injectTheme();
        api.blocks.register({
            type: 'code-block',
            detect: (text) => {
                const match = text.trim().match(FENCE_RE);
                return !!match && !DEDICATED_LANGS.has(match[1] ?? '');
            },
            deserialize: (raw) => {
                const match = String(raw).trim().match(FENCE_RE);
                if (!match)
                    return { lang: '', code: String(raw) };
                return { lang: match[1] ?? '', code: match[2] ?? '' };
            },
            serialize: (data) => {
                const d = data;
                return `\`\`\`${d.lang}\n${d.code}\n\`\`\``;
            },
            createEditorWidget: (_data, _ctx) => ({ mount: (_el) => { }, destroy: () => { } }),
            renderClient: (data, _ctx) => {
                const { lang, code } = data;
                const wrapper = document.createElement('div');
                wrapper.style.cssText = 'position:relative;margin:4px 0';
                if (lang) {
                    const badge = document.createElement('span');
                    badge.style.cssText =
                        'position:absolute;top:8px;right:38px;font-size:11px;' +
                            'color:#585b70;font-family:monospace;padding:1px 6px;' +
                            'background:#313244;border-radius:3px;user-select:none;z-index:1';
                    badge.textContent = lang;
                    wrapper.appendChild(badge);
                }
                const copyBtn = document.createElement('button');
                copyBtn.style.cssText =
                    'position:absolute;top:8px;right:8px;background:#313244;border:none;' +
                        'color:#cdd6f4;border-radius:3px;padding:1px 6px;font-size:12px;cursor:pointer;z-index:1';
                copyBtn.textContent = '⎘';
                copyBtn.title = 'Copier';
                copyBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    navigator.clipboard.writeText(code).then(() => {
                        copyBtn.textContent = '✓';
                        setTimeout(() => { copyBtn.textContent = '⎘'; }, 1500);
                    }).catch(() => { });
                });
                wrapper.appendChild(copyBtn);
                const pre = document.createElement('pre');
                pre.style.cssText =
                    'margin:0;padding:12px 14px;background:#1e1e2e;border-radius:6px;' +
                        'overflow-x:auto;font-family:monospace;font-size:13px;line-height:1.5';
                const codeEl = document.createElement('code');
                try {
                    const result = lang && hljs.getLanguage(lang)
                        ? hljs.highlight(code, { language: lang })
                        : hljs.highlightAuto(code);
                    codeEl.innerHTML = result.value;
                }
                catch {
                    codeEl.textContent = code;
                }
                pre.appendChild(codeEl);
                wrapper.appendChild(pre);
                return wrapper;
            },
        });
    },
    async onunload() { },
};
export default plugin;
//# sourceMappingURL=index.js.map