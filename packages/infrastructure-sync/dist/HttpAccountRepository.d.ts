import { Account, type IAccountRepository } from '@poc/domain-sync';
import { type HttpClientOptions } from './http';
export interface HttpAccountRepositoryOptions extends HttpClientOptions {
}
export declare class HttpAccountRepository implements IAccountRepository {
    private readonly http;
    constructor(options?: HttpAccountRepositoryOptions);
    getById(accountId: string): Promise<Account | undefined>;
    save(_account: Account): Promise<void>;
}
//# sourceMappingURL=HttpAccountRepository.d.ts.map