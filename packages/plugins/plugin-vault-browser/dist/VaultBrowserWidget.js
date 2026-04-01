import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useEffect, useRef } from 'react';
const S = {
    inp: {
        padding: '4px 7px', background: 'rgba(255,255,255,0.07)',
        color: 'inherit', border: '1px solid rgba(255,255,255,0.15)',
        borderRadius: 4, fontSize: 12, outline: 'none', width: '100%',
        boxSizing: 'border-box',
    },
    btn: (color) => ({
        flex: 1, padding: '3px 6px', background: 'rgba(255,255,255,0.05)',
        color, border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4,
        fontSize: 11, cursor: 'pointer',
    }),
    label: {
        fontSize: '0.65rem', fontWeight: 700, color: 'var(--text-faint)',
        textTransform: 'uppercase', letterSpacing: '0.08em',
    },
};
function VaultSettings({ vault, onRename, onDelete, onClose, onAddMember }) {
    const [name, setName] = useState(vault.name);
    const [confirmDel, setConfirmDel] = useState(false);
    const [err, setErr] = useState(null);
    const [shareUserId, setShareUserId] = useState('');
    const [shareRole, setShareRole] = useState('viewer');
    const [shareMsg, setShareMsg] = useState(null);
    async function handleRename() {
        if (!name.trim() || name.trim() === vault.name)
            return;
        try {
            await onRename(name.trim());
            onClose();
        }
        catch {
            setErr('Erreur renommage.');
        }
    }
    async function handleDelete() {
        try {
            await onDelete();
            onClose();
        }
        catch {
            setErr('Erreur suppression.');
        }
    }
    async function handleShare() {
        const uid = shareUserId.trim();
        if (!uid || !onAddMember)
            return;
        setShareMsg(null);
        try {
            await onAddMember(uid, shareRole);
            setShareMsg({ ok: true, text: `${uid} ajouté (${shareRole})` });
            setShareUserId('');
        }
        catch {
            setShareMsg({ ok: false, text: 'Erreur — vérifier le user ID' });
        }
    }
    return (_jsxs("div", { style: { background: 'var(--bg-elevated, rgba(255,255,255,0.04))', borderRadius: 6, padding: '10px 10px 8px', margin: '0 4px 4px', display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 }, children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' }, children: [_jsx("span", { style: { fontWeight: 600, fontSize: 13 }, children: vault.name }), _jsx("button", { onClick: onClose, style: { background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 0 }, children: "\u2715" })] }), _jsx("div", { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }, children: [['Docs', vault.documentCount], ['Dossiers', vault.folderCount]].map(([k, v]) => (_jsxs("div", { style: { background: 'rgba(255,255,255,0.04)', borderRadius: 4, padding: '4px 7px' }, children: [_jsx("div", { style: { fontSize: 9, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.06em' }, children: k }), _jsx("div", { style: { fontWeight: 600 }, children: v })] }, String(k)))) }), err && _jsx("div", { style: { color: 'var(--color-danger, #f66)', fontSize: 11 }, children: err }), _jsxs("div", { style: { display: 'flex', gap: 4 }, children: [_jsx("input", { value: name, onChange: e => setName(e.target.value), onKeyDown: e => e.key === 'Enter' && void handleRename(), style: { ...S.inp, flex: 1 } }), _jsx("button", { onClick: () => void handleRename(), disabled: !name.trim() || name.trim() === vault.name, style: { ...S.btn('var(--color-success, #4caf50)'), flex: 'none', padding: '3px 10px' }, children: "\u21A9" })] }), confirmDel ? (_jsxs("div", { style: { display: 'flex', flexDirection: 'column', gap: 4 }, children: [_jsxs("div", { style: { fontSize: 11, color: 'var(--color-danger, #f66)' }, children: ["Supprimer ", _jsx("strong", { children: vault.name }), " ?"] }), _jsxs("div", { style: { display: 'flex', gap: 4 }, children: [_jsx("button", { onClick: () => void handleDelete(), style: S.btn('var(--color-danger, #f66)'), children: "Supprimer" }), _jsx("button", { onClick: () => setConfirmDel(false), style: S.btn('var(--text-muted)'), children: "Annuler" })] })] })) : (_jsx("button", { onClick: () => setConfirmDel(true), style: { ...S.btn('var(--color-danger, #f66)'), textAlign: 'left' }, children: "Supprimer..." })), onAddMember && (_jsxs("div", { style: { borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }, children: [_jsx("div", { style: { fontSize: 10, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700 }, children: "Partager" }), shareMsg && (_jsx("div", { style: { fontSize: 11, color: shareMsg.ok ? 'var(--color-success, #4caf50)' : 'var(--color-danger, #f66)' }, children: shareMsg.text })), _jsx("input", { value: shareUserId, onChange: e => setShareUserId(e.target.value), onKeyDown: e => e.key === 'Enter' && void handleShare(), placeholder: "User ID", style: S.inp }), _jsxs("div", { style: { display: 'flex', gap: 4 }, children: [_jsxs("select", { value: shareRole, onChange: e => setShareRole(e.target.value), style: { ...S.inp, flex: 1 }, children: [_jsx("option", { value: "viewer", children: "Lecture" }), _jsx("option", { value: "editor", children: "\u00C9diteur" }), _jsx("option", { value: "admin", children: "Admin" })] }), _jsx("button", { onClick: () => void handleShare(), disabled: !shareUserId.trim(), style: { ...S.btn('var(--color-info, #89b4fa)'), flex: 'none', padding: '3px 10px' }, children: "\u2197" })] })] }))] }));
}
function VaultBrowserPanel({ workspace, refs, }) {
    const [vaults, setVaults] = useState([]);
    const [selectedId, setSelectedId] = useState(null);
    const [settingsFor, setSettingsFor] = useState(null);
    const [creating, setCreating] = useState(false);
    const [newName, setNewName] = useState('');
    const inputRef = useRef(null);
    function sync() {
        setVaults([...refs.vaults.current]);
        setSelectedId(refs.selectedVaultId.current);
    }
    useEffect(() => {
        sync();
        return workspace.subscribeVaultChange?.(() => sync());
    }, [workspace]);
    useEffect(() => {
        if (creating)
            inputRef.current?.focus();
    }, [creating]);
    function handleSelect(vault) {
        setSelectedId(vault.id);
        setSettingsFor(null);
        refs.onSelectVault.current(vault);
    }
    async function handleCreate() {
        const n = newName.trim();
        if (!n)
            return;
        try {
            await refs.onCreateVault.current(n);
            setCreating(false);
            setNewName('');
            sync();
        }
        catch { }
    }
    return (_jsxs("div", { style: { height: '100%', display: 'flex', flexDirection: 'column', fontFamily: 'inherit', color: 'inherit', fontSize: 13 }, children: [_jsx("div", { style: { padding: '8px 12px 4px', ...S.label }, children: "Vaults" }), _jsxs("div", { style: { flex: 1, overflowY: 'auto', minHeight: 0 }, children: [vaults.map(v => (_jsxs("div", { children: [_jsxs("div", { style: {
                                    display: 'flex', alignItems: 'center', gap: 2,
                                    background: v.id === selectedId ? 'rgba(255,255,255,0.08)' : 'transparent',
                                }, onMouseEnter: e => {
                                    if (v.id !== selectedId)
                                        e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
                                    const btn = e.currentTarget.querySelector('.cfg-btn');
                                    if (btn)
                                        btn.style.opacity = '1';
                                }, onMouseLeave: e => {
                                    if (v.id !== selectedId)
                                        e.currentTarget.style.background = 'transparent';
                                    const btn = e.currentTarget.querySelector('.cfg-btn');
                                    if (btn)
                                        btn.style.opacity = '0';
                                }, children: [_jsxs("button", { onClick: () => handleSelect(v), style: { flex: 1, textAlign: 'left', padding: '5px 12px', border: 'none', background: 'transparent', color: v.id === selectedId ? 'var(--text)' : 'var(--text-muted)', cursor: 'pointer', minWidth: 0 }, children: [_jsx("div", { style: { fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: v.name }), _jsxs("div", { style: { fontSize: 10, color: 'var(--text-faint)' }, children: [v.role, " \u00B7 ", v.documentCount, " doc", v.documentCount !== 1 ? 's' : ''] })] }), _jsx("button", { className: "cfg-btn", onClick: () => setSettingsFor(prev => prev === v.id ? null : v.id), style: { opacity: 0, background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: '0 8px', fontSize: 13, transition: 'opacity 0.1s' }, title: "Param\u00E8tres", children: "\u2699" })] }), settingsFor === v.id && (_jsx(VaultSettings, { vault: v, onRename: (name) => refs.onRenameVault.current(v, name).then(sync), onDelete: () => refs.onDeleteVault.current(v).then(sync), onClose: () => setSettingsFor(null), onAddMember: refs.onAddMember
                                    ? (userId, role) => refs.onAddMember.current(v, userId, role)
                                    : undefined }))] }, v.id))), vaults.length === 0 && (_jsx("div", { style: { padding: '4px 12px', fontSize: 12, color: 'var(--text-faint)' }, children: "Aucun vault" }))] }), _jsx("div", { style: { flexShrink: 0, borderTop: '1px solid rgba(255,255,255,0.08)', padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 4 }, children: creating ? (_jsxs(_Fragment, { children: [_jsx("input", { ref: inputRef, value: newName, onChange: e => setNewName(e.target.value), onKeyDown: e => { if (e.key === 'Enter')
                                void handleCreate(); if (e.key === 'Escape') {
                                setCreating(false);
                                setNewName('');
                            } }, placeholder: "Nom du vault", style: S.inp }), _jsxs("div", { style: { display: 'flex', gap: 4 }, children: [_jsx("button", { onClick: () => void handleCreate(), disabled: !newName.trim(), style: S.btn('var(--color-success, #4caf50)'), children: "OK" }), _jsx("button", { onClick: () => { setCreating(false); setNewName(''); }, style: S.btn('var(--color-danger, #f66)'), children: "Ann." })] })] })) : (_jsx("button", { onClick: () => setCreating(true), style: { ...S.btn('var(--color-success, #4caf50)'), textAlign: 'left' }, children: "+ Nouveau vault" })) })] }));
}
export class VaultBrowserWidget {
    workspace;
    refs;
    constructor(workspace, refs) {
        this.workspace = workspace;
        this.refs = refs;
    }
    render() {
        return _jsx(VaultBrowserPanel, { workspace: this.workspace, refs: this.refs });
    }
    dispose() { }
}
//# sourceMappingURL=VaultBrowserWidget.js.map