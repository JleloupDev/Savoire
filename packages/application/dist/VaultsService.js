export class VaultsService {
    backend;
    constructor(backend) {
        this.backend = backend;
    }
    list(userId, token) {
        return this.backend.listVaults(userId, token);
    }
    create(userId, name, token) {
        return this.backend.createVault(userId, name, token);
    }
    rename(vaultId, name, token) {
        return this.backend.renameVault(vaultId, name, token);
    }
    delete(vaultId, token) {
        return this.backend.deleteVault(vaultId, token);
    }
    addMember(vaultId, userId, role, token) {
        return this.backend.addMember(vaultId, userId, role, token);
    }
    removeMember(vaultId, memberId, token) {
        return this.backend.removeMember(vaultId, memberId, token);
    }
}
//# sourceMappingURL=VaultsService.js.map