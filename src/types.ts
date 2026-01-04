import type { Input as MainInput, Output as MainOutput } from "../ejs/src/yt/solver/main.ts";

export interface Solvers {
    n: ((val: string) => string) | null;
    sig: ((val: string) => string) | null;
}

export interface SignatureRequest {
    encrypted_signature: string;
    n_param: string;
    player_url: string;
}

export interface SignatureResponse {
    decrypted_signature: string;
    decrypted_n_sig: string;
}

export interface StsRequest {
    player_url: string;
}

export interface StsResponse {
    sts: string;
}

export interface ResolveUrlRequest {
    stream_url: string;
    player_url: string;
    encrypted_signature: string;
    signature_key?: string;
    n_param?: string;
}

export interface ResolveUrlResponse {
    resolved_url: string;
}

export interface WorkerWithLimit extends Worker {
    messagesRemaining: number;
}

export interface Task {
    data: string;
    resolve: (output: string) => void;
    reject: (error: any) => void;
}

export type InFlight = { task: Task; messageHandler: (e: MessageEvent) => void };

export type InFlightWithTimeout = InFlight & { timeoutId: number };

export type SafeCallOptions = {
    /**
     * Optional label used when logging errors.
     */
    label?: string;
    /**
     * If `true`, logs to console.error. If a function, called with (label, err).
     */
    log?: boolean | ((label: string, err: unknown) => void);
    /**
     * Optional callback invoked when the call throws.
     */
    onError?: (err: unknown) => void;
};

export type ApiRequest = SignatureRequest | StsRequest | ResolveUrlRequest;

// Parsing into this context helps avoid multi copies of requests
// since request body can only be read once. 
export interface RequestContext {
    req: Request;
    body: ApiRequest;
}
