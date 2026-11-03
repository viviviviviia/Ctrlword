import { chatText } from '../../../hover/transport';
import { completionEndpoint, DEEPSEEK_DEFAULTS } from '../../../hover/settings';
export async function translate(text, from, to, options = {}) {
    const config = { ...DEEPSEEK_DEFAULTS, ...options.config };
    if (!config.apiKey) throw new Error('请配置 DeepSeek API 密钥');
    return chatText({
        endpoint: completionEndpoint(config.requestPath),
        apiKey: config.apiKey,
        model: config.model,
        stream: config.stream,
        onText: options.setResult,
        timeoutMs: config.timeoutMs || 30000,
        messages: [
            { role: 'system', content: 'Translate the supplied text into ' + to + '. Return only the translation.' },
            { role: 'user', content: text },
        ],
        extra: { thinking: { type: 'disabled' } },
    });
}
export * from './Config';
export * from './info';
