import { ApplicationAPI } from './ApplicationAPI';
import { VaultsService } from './VaultsService';
import { DocumentsService } from './DocumentsService';
import { DocumentSessionService } from './DocumentSessionService';
import { WorkspaceService } from './WorkspaceService';
import { SyncOrchestrator } from './SyncOrchestrator';
export class AppRoot {
    api;
    constructor(deps) {
        const vaults = new VaultsService(deps.backend);
        const sync = new SyncOrchestrator(deps.hubFactory);
        const documents = new DocumentsService(deps.backend, sync);
        const documentSession = new DocumentSessionService(deps.documentStore);
        const workspace = new WorkspaceService();
        this.api = new ApplicationAPI(vaults, documents, documentSession, workspace);
    }
}
//# sourceMappingURL=AppRoot.js.map