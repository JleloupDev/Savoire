import type { ViewContext, VaultAPI } from '@poc/plugin-api';
interface FileTreeProps {
    vault: VaultAPI;
    onOpenFile: (path: string) => void;
    workspace: ViewContext['workspace'];
}
export declare function FileTree({ vault, onOpenFile, workspace }: FileTreeProps): import("react/jsx-runtime").JSX.Element;
export declare class FileTreeWidget {
    private readonly ctx;
    constructor(ctx: ViewContext);
    render(): import("react/jsx-runtime").JSX.Element;
    dispose(): void;
}
export {};
//# sourceMappingURL=FileTreeWidget.d.ts.map