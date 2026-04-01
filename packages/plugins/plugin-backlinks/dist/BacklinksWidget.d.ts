import type { ViewContext, Widget } from '@poc/plugin-api';
import type { BacklinksIndexContributor } from './BacklinksIndexContributor';
export declare class BacklinksWidget implements Widget {
    private readonly ctx;
    private readonly contributor;
    constructor(ctx: ViewContext, contributor: BacklinksIndexContributor);
    render(): import("react/jsx-runtime").JSX.Element;
    dispose(): void;
}
//# sourceMappingURL=BacklinksWidget.d.ts.map