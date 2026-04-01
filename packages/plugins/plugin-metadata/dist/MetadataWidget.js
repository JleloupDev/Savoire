import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// MetadataWidget — affiche les métadonnées indexées du document courant.
//
// DECISION: appel REST GET /api/v1/vaults/{vaultId}/documents/{docId}/meta
// déclenché à chaque changement de document actif via subscribeActiveDocument.
// Pas de poll — mise à jour réactive sur changement d'onglet.
import { useState, useEffect, useCallback, useRef } from 'react';
async function fetchMeta(vaultId, docId, token) {
    try {
        const res = await fetch(`/api/v1/vaults/${vaultId}/documents/${docId}/meta`, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok)
            return null;
        return res.json();
    }
    catch {
        return null;
    }
}
// ── Component ─────────────────────────────────────────────────────────────────
function MetadataPanel({ ctx, vault, }) {
    const { workspace } = ctx;
    const [currentPath, setCurrentPath] = useState(() => workspace.getActiveDocument()?.path ?? null);
    const [meta, setMeta] = useState(null);
    const [loading, setLoading] = useState(false);
    const abortRef = useRef(null);
    const load = useCallback(async (path) => {
        abortRef.current?.abort();
        if (!path) {
            setMeta(null);
            return;
        }
        const vaultId = vault.getVaultId?.() ?? '';
        const docId = vault.resolveDocumentId(path) ?? '';
        const token = vault.getToken?.() ?? '';
        if (!vaultId || !docId) {
            setMeta(null);
            return;
        }
        setLoading(true);
        const ac = new AbortController();
        abortRef.current = ac;
        const result = await fetchMeta(vaultId, docId, token);
        if (!ac.signal.aborted) {
            setMeta(result);
            setLoading(false);
        }
    }, [vault]);
    // Refresh when path changes
    useEffect(() => {
        void load(currentPath);
    }, [currentPath, load]);
    // Subscribe to active-document changes (tab switch + file open)
    useEffect(() => {
        const unsub = workspace.subscribeActiveDocument?.((path) => {
            setCurrentPath(path);
        });
        return unsub;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [workspace]);
    // ── Styles ──────────────────────────────────────────────────────────────────
    const T = {
        panel: { height: '100%', display: 'flex', flexDirection: 'column', fontFamily: 'inherit', color: 'inherit', fontSize: 13 },
        header: { padding: '8px 10px 4px', borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 },
        title: { fontWeight: 600, fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-faint, #888)', marginBottom: 4 },
        docName: { fontSize: '0.78rem', color: 'var(--text, #cdd6f4)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        body: { flex: 1, overflow: 'auto', padding: '6px 10px' },
        empty: { padding: '8px 0', fontSize: '0.75rem', color: 'var(--text-faint, #888)', fontStyle: 'italic' },
        section: { marginBottom: 12 },
        sectionTitle: { fontSize: '0.65rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-faint, #888)', marginBottom: 4 },
        tag: { display: 'inline-block', padding: '1px 7px', borderRadius: 4, background: 'rgba(139,92,246,0.18)', color: 'var(--accent, #8b5cf6)', fontSize: '0.7rem', marginRight: 4, marginBottom: 4 },
        row: { display: 'flex', gap: 6, marginBottom: 3, fontSize: '0.75rem' },
        key: { color: 'var(--text-faint, #888)', flexShrink: 0, minWidth: 80 },
        val: { color: 'var(--text, #cdd6f4)', wordBreak: 'break-all', flex: 1 },
        pill: { fontSize: '0.65rem', padding: '1px 5px', borderRadius: 3, background: 'rgba(255,255,255,0.07)', color: 'var(--text-faint, #888)' },
    };
    const fmEntries = meta ? Object.entries(meta.frontmatter) : [];
    return (_jsxs("div", { style: T.panel, children: [_jsxs("div", { style: T.header, children: [_jsx("div", { style: T.title, children: "M\u00E9tadonn\u00E9es" }), currentPath
                        ? _jsx("div", { style: T.docName, children: currentPath.split('/').at(-1) })
                        : _jsx("div", { style: T.docName, children: "\u2014" })] }), _jsxs("div", { style: T.body, children: [!currentPath && (_jsx("div", { style: T.empty, children: "Ouvrir un document pour voir ses m\u00E9tadonn\u00E9es." })), currentPath && loading && (_jsx("div", { style: T.empty, children: "Chargement\u2026" })), currentPath && !loading && !meta && (_jsx("div", { style: T.empty, children: "Pas de m\u00E9tadonn\u00E9es index\u00E9es pour ce document." })), meta && (_jsxs(_Fragment, { children: [meta.tags.length > 0 && (_jsxs("div", { style: T.section, children: [_jsx("div", { style: T.sectionTitle, children: "Tags" }), _jsx("div", { children: meta.tags.map(t => _jsxs("span", { style: T.tag, children: ["#", t] }, t)) })] })), fmEntries.length > 0 && (_jsxs("div", { style: T.section, children: [_jsx("div", { style: T.sectionTitle, children: "Frontmatter" }), fmEntries.map(([k, v]) => (_jsxs("div", { style: T.row, children: [_jsx("span", { style: T.key, children: k }), _jsx("span", { style: T.val, children: v })] }, k)))] })), _jsxs("div", { style: T.section, children: [_jsx("div", { style: T.sectionTitle, children: "Technique" }), meta.contentType && (_jsxs("div", { style: T.row, children: [_jsx("span", { style: T.key, children: "type" }), _jsx("span", { style: { ...T.pill, ...T.val }, children: meta.contentType })] })), meta.derivedFrom && (_jsxs("div", { style: T.row, children: [_jsx("span", { style: T.key, children: "derivedFrom" }), _jsx("span", { style: T.val, children: meta.derivedFrom })] })), meta.derivedBy && (_jsxs("div", { style: T.row, children: [_jsx("span", { style: T.key, children: "derivedBy" }), _jsx("span", { style: T.val, children: meta.derivedBy })] })), _jsxs("div", { style: T.row, children: [_jsx("span", { style: T.key, children: "indexedAt" }), _jsx("span", { style: T.val, children: new Date(meta.indexedAt).toLocaleString() })] })] })] }))] })] }));
}
// ── Widget wrapper ─────────────────────────────────────────────────────────────
export class MetadataWidget {
    ctx;
    vault;
    constructor(ctx, vault) {
        this.ctx = ctx;
        this.vault = vault;
    }
    render() {
        return _jsx(MetadataPanel, { ctx: this.ctx, vault: this.vault });
    }
    dispose() { }
}
//# sourceMappingURL=MetadataWidget.js.map