export class SyncOrchestrator {
    hubFactory;
    activeHub = null;
    activeVaultId = null;
    constructor(hubFactory) {
        this.hubFactory = hubFactory;
    }
    async attachVaultSync(vaultId, vaultClient, onChanged) {
        // Idempotent attach: keep the current hub when the target vault is unchanged.
        if (this.activeHub && this.activeVaultId === vaultId)
            return this.activeHub;
        await this.disposeActive();
        const hub = this.hubFactory.create({ vaultId, vaultClient, onChanged });
        this.activeHub = hub;
        this.activeVaultId = vaultId;
        await hub.connect();
        return hub;
    }
    async disposeActive() {
        if (!this.activeHub)
            return;
        await this.activeHub.dispose();
        this.activeHub = null;
        this.activeVaultId = null;
    }
}
//# sourceMappingURL=SyncOrchestrator.js.map