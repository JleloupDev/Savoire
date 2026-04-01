function now() {
    return new Date();
}
function trimNonEmpty(value, label) {
    const v = value.trim();
    if (!v)
        throw new Error(`${label} must not be empty`);
    return v;
}
function parentPath(path) {
    const i = path.lastIndexOf('/');
    return i === -1 ? '' : path.slice(0, i + 1);
}
export class Document {
    id;
    name;
    path;
    title;
    content;
    isDeleted;
    updatedAt;
    constructor(params) {
        this.id = params.id;
        this.name = trimNonEmpty(params.name, 'name');
        this.path = trimNonEmpty(params.path, 'path');
        this.title = params.title ?? '';
        this.content = params.content ?? '';
        this.isDeleted = params.isDeleted ?? false;
        this.updatedAt = params.updatedAt ?? now();
    }
    toMeta() {
        return {
            documentId: this.id,
            name: this.name,
            path: this.path,
            updatedAt: this.updatedAt,
        };
    }
    renameTo(newName) {
        const normalized = trimNonEmpty(newName, 'newName');
        this.name = normalized;
        this.path = parentPath(this.path) + normalized;
        this.updatedAt = now();
    }
    moveTo(newPath) {
        const normalized = trimNonEmpty(newPath, 'newPath');
        this.path = normalized;
        const slashIdx = normalized.lastIndexOf('/');
        this.name = slashIdx === -1 ? normalized : normalized.slice(slashIdx + 1);
        this.updatedAt = now();
    }
    setContent(content) {
        this.content = content;
        this.updatedAt = now();
    }
    markDeleted() {
        this.isDeleted = true;
        this.updatedAt = now();
    }
    restore() {
        this.isDeleted = false;
        this.updatedAt = now();
    }
}
//# sourceMappingURL=Document.js.map