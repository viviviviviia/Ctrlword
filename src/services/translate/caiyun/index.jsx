import { fetch, Body } from '@tauri-apps/api/http';

export async function translate(text, from, to, options = {}) {
    const { config } = options;

    const { token } = config;

    const url = 'https://api.interpreter.caiyunai.com/v1/translator';

    if (token === '') {
        throw 'Please configure token';
    }

    const body = {
        source: options.dictionary && options.context ? [text, options.context] : [text],
        trans_type: `${from}2${to}`,
        request_id: 'demo',
        detect: true,
    };

    const headers = {
        'content-type': 'application/json',
        'x-authorization': 'token ' + token,
    };

    let res = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: Body.json(body),
    });

    if (res.ok) {
        let result = res.data;
        const { target } = result;
        if (target[0]) {
            if (options.dictionary) return { senses: [{ definition: target[0] }], contextTranslation: target[1] || null };
            return target[0];
        } else {
            throw JSON.stringify(result.trim());
        }
    } else {
        throw `Http Request Error\nHttp Status: ${res.status}\n${JSON.stringify(res.data)}`;
    }
}

export * from './Config';
export * from './info';
