import type { ViewRegistry, ViewSpec } from '@poc/plugin-api';
export declare class ViewRegistryImpl implements ViewRegistry {
    private readonly specs;
    register(spec: ViewSpec): void;
    unregister(id: string): void;
    getAll(): ViewSpec[];
    get(id: string): ViewSpec | undefined;
}
//# sourceMappingURL=ViewRegistryImpl.d.ts.map