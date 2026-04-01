export interface EditorPositionAPI {
    getCursorCoords(): {
        x: number;
        y: number;
    } | null;
    getSelectionCoords(): {
        x: number;
        y: number;
    } | null;
    getSelectionText(): string;
}
export interface EditorCommandContext {
}
export interface ToolbarCommand {
    id: string;
    label: string;
    icon: string;
    group?: string;
    requiresSelection?: boolean;
    hotkeys?: Array<{
        modifiers: string[];
        key: string;
    }>;
    run(ctx: EditorCommandContext): void;
    isActive?(ctx: EditorCommandContext): boolean;
    isEnabled?(ctx: EditorCommandContext): boolean;
}
export interface ToolbarCommandRegistry {
    register(cmd: ToolbarCommand): void;
    unregister(id: string): void;
    getAll(): ToolbarCommand[];
    getByGroup(group: string): ToolbarCommand[];
}
//# sourceMappingURL=editor.d.ts.map