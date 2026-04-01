import type { ILocalIndexStorage } from './ports';
/**
 * InMemoryIndexStorage — implémentation POC de ILocalIndexStorage.
 * Les snapshots sont perdus au rechargement de la page.
 * see ADR-021
 */
export declare class InMemoryIndexStorage implements ILocalIndexStorage {
    private readonly store;
    loadSnapshot(namespace: string): Promise<{
        data: string;
        seq: number;
    } | null>;
    saveSnapshot(namespace: string, data: string, seq: number): Promise<void>;
}
//# sourceMappingURL=LocalIndexStorage.d.ts.map