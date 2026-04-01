import type { DocumentStore } from '@poc/platform';
import type { IApplicationAPI, IVaultHubFactory, IVaultsBackend } from './contracts';
export interface AppRootDeps {
    backend: IVaultsBackend;
    hubFactory: IVaultHubFactory;
    documentStore: DocumentStore;
}
export declare class AppRoot {
    readonly api: IApplicationAPI;
    constructor(deps: AppRootDeps);
}
//# sourceMappingURL=AppRoot.d.ts.map