import { invoke } from '@tauri-apps/api/tauri';
import { listen } from '@tauri-apps/api/event';

export async function chatText({
    endpoint,
    apiKey,
    azure = false,
    model,
    messages,
    stream = true,
    timeoutMs = 12000,
    kind = 'openai',
    extra = {},
    sessionId = null,
    signal,
    onText,
}) {
    if (signal?.aborted) throw new Error('Cancelled');
    const requestId = crypto.randomUUID();
    const unlisten = await listen('chd:stream', (event) => {
        if (!signal?.aborted && event.payload.requestId === requestId) onText?.(event.payload.text);
    });
    const cancel = () => {
        void invoke('dictionary_cancel', { requestId });
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
        if (signal?.aborted) throw new Error('Cancelled');
        const text = await invoke('dictionary_chat', {
            request: {
                requestId,
                sessionId,
                endpoint,
                apiKey,
                azure,
                timeoutMs,
                kind,
                body: { ...extra, model, messages, stream },
            },
        });
        if (signal?.aborted) throw new Error('Cancelled');
        return text;
    } finally {
        signal?.removeEventListener('abort', cancel);
        unlisten();
    }
}

export function deadline(promise, timeoutMs, signal) {
    return new Promise((resolve, reject) => {
        const abort = () => reject(new Error('Cancelled'));
        const timer = setTimeout(() => reject(new Error('Request timeout')), timeoutMs);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        promise.then(resolve, reject).finally(() => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
        });
    });
}
