import * as services from '../services/translate';
import { store } from '../utils/store';
import { invoke_plugin } from '../utils/invoke_plugin';
import { completedJsonFields, normalizeDictionary } from './core.js';
import { DEEPSEEK_DEFAULTS, completionEndpoint, dictionaryMessages } from './settings.js';
import { createLookup } from './lookup.js';
import { chatText, deadline } from './transport.js';
import { getCached, putCached } from './storage.js';

export async function providerList() {
    return [
        ...new Set([
            'deepseek',
            'deepl',
            'caiyun',
            'baidu',
            'openai',
            'ollama',
            ...((await store.get('translate_service_list')) || []),
        ]),
    ];
}

async function callProvider(query, config, options) {
    const name = query.provider.split('@')[0];
    if (['deepseek', 'openai', 'ollama'].includes(name)) {
        const ollama = name === 'ollama';
        if (!ollama && !config.apiKey) throw new Error('请先在服务设置中填写 API 密钥');
        const extra = name === 'openai' ? JSON.parse(config.requestArguments || '{}') : {};
        if (ollama) {
            extra.format = 'json';
            extra.think = false;
        } else {
            extra.response_format = { type: 'json_object' };
        }
        if (name === 'deepseek') extra.thinking = { type: 'disabled' };
        const text = await chatText({
            endpoint: query.endpoint,
            apiKey: config.apiKey,
            azure: name === 'openai' && config.service === 'azure',
            model: query.model,
            messages: dictionaryMessages(query),
            stream: config.stream !== false,
            kind: ollama ? 'ollama' : 'openai',
            timeoutMs: options.timeoutMs,
            extra,
            sessionId: options.sessionId,
            signal: options.signal,
            onText: (text) => {
                const fields = completedJsonFields(text);
                options.onPartial?.({ ...fields, word: query.word, provider: query.provider, context: query.context });
            },
        });
        let value;
        try {
            value = JSON.parse(text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/gu, ''));
        } catch {
            throw new Error('翻译服务未返回完整词典 JSON，请重试或切换服务');
        }
        return normalizeDictionary(value, query);
    }
    let service, utils;
    if (name.startsWith('plugin')) {
        const [translate, suppliedUtils] = await invoke_plugin('translate', name);
        service = { translate, Language: {} };
        utils = suppliedUtils;
    } else service = services[name];
    if (!service?.translate) throw new Error('此服务不可用，请在服务设置中重新配置');
    const from = service.Language?.[query.from] ?? query.from;
    const to = service.Language?.[query.to] ?? query.to;
    if (!name.startsWith('plugin') && service.Language && !(query.to in service.Language))
        throw new Error('服务不支持此目标语言');
    if (name === 'baidu' && (!config.appid || !config.secret)) throw new Error('请配置百度 App ID 和密钥');
    if (name === 'caiyun' && !config.token) throw new Error('请配置彩云 Token');
    const value = await deadline(
        service.translate(query.word, from, to, {
            config,
            detect: query.from,
            dictionary: true,
            context: query.context,
            utils,
            setResult: () => {},
        }),
        options.timeoutMs,
        options.signal
    );
    if (options.signal?.aborted) throw new Error('Cancelled');
    return normalizeDictionary(value, query);
}

export const lookupDictionary = createLookup({
    prepare: async (provider, target, settings) => {
        const name = provider.split('@')[0];
        const config = { ...(name === 'deepseek' ? DEEPSEEK_DEFAULTS : {}), ...((await store.get(provider)) || {}) };
        const query = {
            word: target.word,
            context: target.context,
            from: 'auto',
            to: settings.targetLanguage,
            provider,
        };
        if (['deepseek', 'openai', 'ollama'].includes(name)) {
            query.model = config.model;
            query.endpoint = completionEndpoint(
                config.requestPath || (name === 'ollama' ? 'http://localhost:11434' : 'https://api.openai.com/v1'),
                name === 'ollama'
            );
        }
        return { query, config };
    },
    request: callProvider,
    readCache: getCached,
    writeCache: putCached,
});
