import type { Widget } from '@poc/plugin-api';
export interface VaultSummaryLike {
    id: string;
    name: string;
    role: string;
    documentCount: number;
    folderCount: number;
}
export interface VaultBrowserRefs<TVault extends VaultSummaryLike = VaultSummaryLike> {
    vaults: React.MutableRefObject<TVault[]>;
    selectedVaultId: React.MutableRefObject<string | null>;
    onSelectVault: React.MutableRefObject<(vault: TVault) => void>;
    onCreateVault: React.MutableRefObject<(name: string) => Promise<void>>;
    onRenameVault: React.MutableRefObject<(vault: TVault, name: string) => Promise<void>>;
    onDeleteVault: React.MutableRefObject<(vault: TVault) => Promise<void>>;
    onAddMember?: React.MutableRefObject<(vault: TVault, userId: string, role: string) => Promise<void>>;
}
export interface VaultBrowserWorkspaceLike {
    subscribeVaultChange?: (cb: () => void) => () => void;
}
export declare class VaultBrowserWidget<TVault extends VaultSummaryLike = VaultSummaryLike> implements Widget {
    private readonly workspace;
    private readonly refs;
    constructor(workspace: VaultBrowserWorkspaceLike, refs: VaultBrowserRefs<TVault>);
    render(): import("react/jsx-runtime").JSX.Element;
    dispose(): void;
}
//# sourceMappingURL=VaultBrowserWidget.d.ts.map