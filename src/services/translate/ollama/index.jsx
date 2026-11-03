import { Language } from './info';
import { completionEndpoint } from '../../../hover/settings';
import { chatText } from '../../../hover/transport';

export async function translate(text, from, to, options = {}) {
    const { config, setResult, detect } = options;
    const address = /^https?:\/\//u.test(config.requestPath) ? config.requestPath : `http://${config.requestPath}`;
    const messages = (
        config.promptList || [
            { role: 'system', content: 'Translate into $to. Return only the translation.' },
            { role: 'user', content: '$text' },
        ]
    ).map((item) => ({
        ...item,
        content: item.content
            .replaceAll('$text', text)
            .replaceAll('$from', from)
            .replaceAll('$to', to)
            .replaceAll('$detect', Language[detect] || detect || from),
    }));
    return chatText({
        endpoint: completionEndpoint(address, true),
        model: config.model,
        messages,
        stream: config.stream,
        onText: setResult,
        kind: 'ollama',
        timeoutMs: config.timeoutMs || 60000,
    });
}
export * from './Config';
export * from './info';
