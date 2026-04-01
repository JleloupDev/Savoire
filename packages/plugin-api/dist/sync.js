// ─── Sync / DocumentRoom ─────────────────────────────────────────────────
//
// API format-agnostic de synchronisation temps réel pour les documents non-CRDT
// (Excalidraw, tableaux, schémas, etc.). Modèle last-write-wins par snapshot JSON.
//
// Usage dans un plugin :
//   const room = await api.sync.openRoom(vaultId, docId, userId)
//   room.onSnapshot((json, fromUserId) => { /* update local view */ })
//   room.pushSnapshot(json)    // debounced inside plugin
//   room.close()               // on FileView.destroy()
export {};
//# sourceMappingURL=sync.js.map