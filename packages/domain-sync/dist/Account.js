function trimNonEmpty(value, label) {
    const v = value.trim();
    if (!v)
        throw new Error(`${label} must not be empty`);
    return v;
}
export class Account {
    id;
    displayName;
    email;
    vaultsById = new Map();
    constructor(params) {
        this.id = params.id;
        this.displayName = trimNonEmpty(params.displayName, 'displayName');
        this.email = trimNonEmpty(params.email, 'email');
        for (const vault of params.vaults ?? [])
            this.vaultsById.set(vault.id, vault);
    }
    addVault(vault) {
        this.vaultsById.set(vault.id, vault);
    }
    removeVault(vaultId) {
        this.vaultsById.delete(vaultId);
    }
    getVault(vaultId) {
        return this.vaultsById.get(vaultId);
    }
    listVaults() {
        return Array.from(this.vaultsById.values()).sort((a, b) => a.name.localeCompare(b.name));
    }
}
//# sourceMappingURL=Account.js.map