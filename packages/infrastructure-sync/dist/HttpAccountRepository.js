import { Account } from '@poc/domain-sync';
import { HttpClient } from './http';
export class HttpAccountRepository {
    http;
    constructor(options = {}) {
        this.http = new HttpClient(options);
    }
    async getById(accountId) {
        try {
            const dto = await this.http.getJson(`/api/v1/users/${encodeURIComponent(accountId)}`);
            return new Account({
                id: str(dto.id ?? dto.Id),
                displayName: str(dto.displayName ?? dto.DisplayName),
                email: str(dto.email ?? dto.Email),
            });
        }
        catch (err) {
            if (is404(err))
                return undefined;
            throw err;
        }
    }
    async save(_account) {
        throw new Error('HttpAccountRepository.save is not supported by current API contracts');
    }
}
function str(value) {
    return typeof value === 'string' ? value : '';
}
function is404(err) {
    return err instanceof Error && err.message.includes('404');
}
//# sourceMappingURL=HttpAccountRepository.js.map