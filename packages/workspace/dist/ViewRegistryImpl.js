export class ViewRegistryImpl {
    specs = new Map();
    register(spec) {
        this.specs.set(spec.id, spec);
    }
    unregister(id) {
        this.specs.delete(id);
    }
    getAll() {
        return Array.from(this.specs.values());
    }
    get(id) {
        return this.specs.get(id);
    }
}
//# sourceMappingURL=ViewRegistryImpl.js.map