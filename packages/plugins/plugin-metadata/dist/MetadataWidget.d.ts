import type { ViewContext, VaultAPI, Widget } from '@poc/plugin-api';
export declare class MetadataWidget implements Widget {
    private readonly ctx;
    private readonly vault;
    constructor(ctx: ViewContext, vault: VaultAPI);
    render(): import("react/jsx-runtime").JSX.Element;
    dispose(): void;
}
//# sourceMappingURL=MetadataWidget.d.ts.map