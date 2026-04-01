import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// BacklinksWidget — affiche les documents qui pointent vers le document courant.
//
// see ADR-017
import { useState, useEffect, useCallback } from 'react';
// ── Component ─────────────────────────────────────────────────────────────────
function BacklinksPanel({ ctx, contributor, }) {
    const { workspace } = ctx;
    const [currentPath, setCurrentPath] = useState(() => workspace.getActiveDocument()?.path ?? null);
    const [backlinks, setBacklinks] = useState([]);
    const refresh = useCallback((path) => {
        if (!path) {
            setBacklinks([]);
            return;
        }
        setBacklinks(contributor.getBacklinks(path));
    }, [contributor]);
    // Refresh on path change
    useEffect(() => {
        refresh(currentPath);
    }, [currentPath, refresh]);
    // Subscribe to active-document changes (tab switch + file open)
    useEffect(() => {
        // subscribeActiveDocument fires on both tab switches (Dockview) and new file opens
        const unsub = workspace.subscribeActiveDocument?.((path) => {
            setCurrentPath(path);
        });
        return unsub;
    }, [workspace, setCurrentPath]);
    // ── Styles ──────────────────────────────────────────────────────────────────
    const T = {
        panel: { height: '100%', display: 'flex', flexDirection: 'column', fontFamily: 'inherit', color: 'inherit', fontSize: 13 },
        header: { padding: '8px 10px 4px', borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 },
        title: { fontWeight: 600, fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-faint, #888)', marginBottom: 4 },
        docName: { fontSize: '0.78rem', color: 'var(--text, #cdd6f4)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        body: { flex: 1, overflow: 'auto', padding: '4px 0' },
        empty: { padding: '12px 10px', fontSize: '0.75rem', color: 'var(--text-faint, #888)', fontStyle: 'italic' },
        item: { padding: '5px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, borderRadius: 4, margin: '0 4px' },
        badge: { fontSize: '0.6rem', padding: '1px 5px', borderRadius: 4, background: 'rgba(255,255,255,0.07)', color: 'var(--text-faint, #888)', flexShrink: 0 },
    };
    return (_jsxs("div", { style: T.panel, children: [_jsxs("div", { style: T.header, children: [_jsx("div", { style: T.title, children: "Backlinks" }), currentPath
                        ? _jsx("div", { style: T.docName, children: currentPath.split('/').at(-1) })
                        : _jsx("div", { style: T.docName, children: "\u2014" })] }), _jsxs("div", { style: T.body, children: [!currentPath && (_jsx("div", { style: T.empty, children: "Ouvrir un document pour voir ses backlinks." })), currentPath && backlinks.length === 0 && (_jsx("div", { style: T.empty, children: "Aucun document ne pointe vers celui-ci." })), backlinks.map(bl => (_jsxs("div", { style: T.item, onClick: () => void workspace.openFile(bl.path), onMouseEnter: e => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }, onMouseLeave: e => { e.currentTarget.style.background = 'transparent'; }, children: [_jsx("span", { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: bl.path.split('/').at(-1) }), _jsx("span", { style: T.badge, children: "wikilink" })] }, bl.docId)))] })] }));
}
// ── Widget wrapper ─────────────────────────────────────────────────────────────
export class BacklinksWidget {
    ctx;
    contributor;
    constructor(ctx, contributor) {
        this.ctx = ctx;
        this.contributor = contributor;
    }
    render() {
        return _jsx(BacklinksPanel, { ctx: this.ctx, contributor: this.contributor });
    }
    dispose() { }
}
//# sourceMappingURL=BacklinksWidget.js.map