import type { ViewContext } from '@poc/plugin-api';
import type { GraphIndexContributor } from './GraphIndexContributor';
import type { Widget } from '@poc/plugin-api';
export declare class GraphWidget implements Widget {
    private readonly ctx;
    private readonly contributor;
    constructor(ctx: ViewContext, contributor: GraphIndexContributor);
    render(): import("react/jsx-runtime").JSX.Element;
    dispose(): void;
}
//# sourceMappingURL=GraphWidget.d.ts.map