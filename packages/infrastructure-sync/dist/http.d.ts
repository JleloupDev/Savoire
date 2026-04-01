export interface HttpClientOptions {
    baseUrl?: string;
    getToken?: () => string | null | undefined;
    fetchFn?: typeof fetch;
}
export declare class HttpClient {
    private readonly baseUrl;
    private readonly getToken;
    private readonly fetchFn;
    constructor(options?: HttpClientOptions);
    getJson<T>(path: string): Promise<T>;
    postJson<T>(path: string, body: unknown): Promise<T>;
    patchJson<T>(path: string, body: unknown): Promise<T>;
    putText(path: string, body: string): Promise<void>;
    getText(path: string): Promise<string>;
    delete(path: string): Promise<void>;
    private requestJson;
    private makeHeaders;
    private resolve;
}
//# sourceMappingURL=http.d.ts.map