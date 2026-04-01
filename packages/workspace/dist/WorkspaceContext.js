import { createContext, useContext } from 'react';
// DECISION: expose the full WorkspaceManagerImpl (not just WorkspaceAPI) so
// apps can access the view registry. Plugins receive only WorkspaceAPI via ViewContext.
export const WorkspaceContext = createContext(null);
export function useWorkspace() {
    const ctx = useContext(WorkspaceContext);
    if (!ctx)
        throw new Error('useWorkspace must be used inside <WorkspaceRoot>');
    return ctx;
}
//# sourceMappingURL=WorkspaceContext.js.map