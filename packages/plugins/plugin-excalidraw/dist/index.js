import { jsx as _jsx } from "react/jsx-runtime";
import { createRoot } from 'react-dom/client';
import { Excalidraw, serializeAsJSON } from '@excalidraw/excalidraw';
import { excalidrawContentExtractor } from './content-extractor';
const SAVE_DEBOUNCE_MS = 500;
// DECISION: ContentExtractor dans content-extractor.ts (pas de dépendance Excalidraw UI).
export { excalidrawContentExtractor } from './content-extractor';
const EMPTY_SCENE = { elements: [], appState: { viewBackgroundColor: '#1e1e2e' }, files: {} };
// ── FileView ─────────────────────────────────────────────────────────────────
function createExcalidrawView(path, ctx, sync) {
    const vault = ctx.vault;
    let root = null;
    let saveTimer = null;
    let room = null;
    let unsubRoom = null;
    let excalidrawAPI = null;
    let isApplyingRemote = false;
    let pendingRemoteSnapshot = null;
    let pendingElements = null;
    let pendingAppState = null;
    let pendingFiles = null;
    // DECISION: compteur de génération — invalide les callbacks async d'un mount()
    // précédent même si destroy() a été appelé puis mount() a réinitialisé les flags.
    let generation = 0;
    function scheduleSave(elements, state, files) {
        if (isApplyingRemote)
            return;
        pendingElements = elements;
        pendingAppState = state;
        pendingFiles = files;
        if (saveTimer !== null)
            clearTimeout(saveTimer);
        saveTimer = setTimeout(() => flushSave(), SAVE_DEBOUNCE_MS);
    }
    function flushSave() {
        saveTimer = null;
        if (!pendingElements || !pendingAppState || !pendingFiles)
            return;
        const json = serializeAsJSON(pendingElements, pendingAppState, pendingFiles, 'local');
        if (room) {
            room.pushSnapshot(json).catch(err => console.error('[plugin-excalidraw] pushSnapshot error', err));
        }
        else if (vault) {
            const docId = vault.resolveDocumentId(path);
            if (!docId)
                return;
            vault.write(docId, json).catch(err => console.error('[plugin-excalidraw] save error', err));
        }
        // DECISION: notifie l'app layer pour mettre à jour l'index local.
        // L'app layer possède le contentExtractor et fait la conversion raw → shadow.
        ctx.onContentStabilized?.(json);
    }
    function applyRemoteSnapshot(data) {
        if (!excalidrawAPI) {
            pendingRemoteSnapshot = data;
            return;
        }
        isApplyingRemote = true;
        try {
            const d = data;
            excalidrawAPI.updateScene({
                elements: d.elements ?? [],
                appState: d.appState ?? {},
                files: d.files ?? {},
            });
        }
        finally {
            setTimeout(() => { isApplyingRemote = false; }, 0);
        }
    }
    function ExcalidrawEditor({ initialData }) {
        return (_jsx("div", { style: { height: '100%', width: '100%' }, children: _jsx(Excalidraw
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            , { 
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                initialData: initialData, onChange: scheduleSave, theme: "dark", excalidrawAPI: (api) => {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    excalidrawAPI = api;
                    if (pendingRemoteSnapshot !== null) {
                        const snap = pendingRemoteSnapshot;
                        pendingRemoteSnapshot = null;
                        applyRemoteSnapshot(snap);
                    }
                } }) }));
    }
    return {
        mount(container) {
            // Incrémenter la génération — invalide tous les callbacks async du mount précédent.
            const myGen = ++generation;
            // Démonter le root précédent synchroniquement pour éviter l'avertissement
            // React "createRoot on a container that already has a root".
            if (root) {
                root.unmount();
                root = null;
            }
            // Réinitialiser l'état partagé.
            if (saveTimer !== null) {
                clearTimeout(saveTimer);
                saveTimer = null;
            }
            unsubRoom?.();
            unsubRoom = null;
            room?.close().catch(() => { });
            room = null;
            excalidrawAPI = null;
            pendingRemoteSnapshot = null;
            container.innerHTML = '';
            container.style.cssText = 'height:100%;width:100%;overflow:hidden';
            root = createRoot(container);
            (async () => {
                let initialData = EMPTY_SCENE;
                if (vault) {
                    try {
                        const raw = await vault.readDocumentByPath(path);
                        if (raw.trim())
                            initialData = JSON.parse(raw);
                    }
                    catch {
                        console.error('[plugin-excalidraw] erreur de chargement');
                    }
                }
                // Vérifier que ce mount() est toujours le courant.
                if (generation !== myGen)
                    return;
                root?.render(_jsx(ExcalidrawEditor, { initialData: initialData }));
                if (sync && vault) {
                    const docId = vault.resolveDocumentId(path);
                    if (docId) {
                        const userId = ctx.userId ?? 'anonymous';
                        try {
                            const openedRoom = await sync.openRoom(ctx.vaultId, docId, userId);
                            if (generation !== myGen) {
                                openedRoom.close().catch(() => { });
                                return;
                            }
                            room = openedRoom;
                            unsubRoom = room.onSnapshot((snapshotJson) => {
                                try {
                                    applyRemoteSnapshot(JSON.parse(snapshotJson));
                                }
                                catch {
                                    console.warn('[plugin-excalidraw] snapshot JSON invalide');
                                }
                            });
                        }
                        catch (err) {
                            console.warn('[plugin-excalidraw] room.open error', err);
                        }
                    }
                }
            })();
        },
        destroy() {
            // Invalider tout async en cours : le prochain mount() incrémentera generation.
            // Ne pas incrémenter ici — destroy() seul (sans mount() après) doit juste nettoyer.
            if (saveTimer !== null) {
                clearTimeout(saveTimer);
                flushSave();
            }
            unsubRoom?.();
            unsubRoom = null;
            room?.close().catch(() => { });
            room = null;
            excalidrawAPI = null;
            pendingRemoteSnapshot = null;
            root?.unmount();
            root = null;
        },
    };
}
// ── Plugin ────────────────────────────────────────────────────────────────────
const plugin = {
    manifest: {
        id: 'plugin-excalidraw',
        name: 'Excalidraw',
        version: '0.0.1',
        description: 'Éditeur de dessin vectoriel Excalidraw pour les fichiers .excalidraw',
        permissions: ['ui:editor', 'vault:read', 'vault:write'],
        defaultActive: false,
    },
    async onload(api) {
        api.files.register({
            extension: 'excalidraw',
            label: 'Dessin Excalidraw',
            icon: '✏️',
            create: async () => JSON.stringify(EMPTY_SCENE, null, 2),
            open: (path, ctx) => createExcalidrawView(path, ctx, api.sync),
            contentExtractor: excalidrawContentExtractor,
            renderEmbed: async (path, ctx) => {
                const wrapper = document.createElement('div');
                wrapper.style.cssText = [
                    'height:320px', 'width:100%',
                    'border:1px solid var(--border,#313244)',
                    'border-radius:6px', 'overflow:hidden',
                ].join(';');
                let initialData = EMPTY_SCENE;
                if (ctx.vault) {
                    try {
                        const raw = await ctx.vault.readDocumentByPath(path);
                        if (raw.trim())
                            initialData = JSON.parse(raw);
                    }
                    catch { /* POC: ignoré */ }
                }
                const embedRoot = createRoot(wrapper);
                embedRoot.render(_jsx("div", { style: { height: '100%', width: '100%' }, children: _jsx(Excalidraw
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    , { 
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        initialData: initialData, viewModeEnabled: true, theme: "dark" }) }));
                return wrapper;
            },
        });
    },
    async onunload() { },
};
export default plugin;
//# sourceMappingURL=index.js.map