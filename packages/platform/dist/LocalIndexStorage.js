/**
 * InMemoryIndexStorage — implémentation POC de ILocalIndexStorage.
 * Les snapshots sont perdus au rechargement de la page.
 * see ADR-021
 */
export class InMemoryIndexStorage {
    store = new Map();
    async loadSnapshot(namespace) {
        return this.store.get(namespace) ?? null;
    }
    async saveSnapshot(namespace, data, seq) {
        this.store.set(namespace, { data, seq });
    }
}
//# sourceMappingURL=LocalIndexStorage.js.map