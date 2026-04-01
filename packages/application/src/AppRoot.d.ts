// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { DocumentStore } from '@savoire/platform';
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