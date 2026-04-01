import { Document, Vault } from '@poc/domain-sync';
function str(value) {
    return typeof value === 'string' ? value : '';
}
function parseDate(value) {
    if (typeof value !== 'string')
        return new Date(0);
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? new Date(0) : d;
}
// DTOs can come in camelCase or PascalCase depending on backend config.
export function mapDocumentMeta(dto) {
    return {
        documentId: str(dto.id ?? dto.Id),
        name: str(dto.name ?? dto.Name ?? dto.path ?? dto.Path).split('/').at(-1) ?? '',
        path: str(dto.path ?? dto.Path),
        updatedAt: parseDate(dto.updatedAt ?? dto.UpdatedAt),
    };
}
export function mapDocument(dto, content) {
    const path = str(dto.path ?? dto.Path);
    const name = path.split('/').at(-1) ?? path;
    return new Document({
        id: str(dto.id ?? dto.Id),
        name,
        path,
        title: str(dto.title ?? dto.Title),
        content,
        isDeleted: false,
        updatedAt: parseDate(dto.updatedAt ?? dto.UpdatedAt),
    });
}
export function mapVault(dto) {
    const id = str(dto.id ?? dto.Id);
    const name = str(dto.name ?? dto.Name);
    return new Vault({ id, name });
}
//# sourceMappingURL=mappers.js.map