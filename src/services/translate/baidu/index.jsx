import { fetch } from '@tauri-apps/api/http';
import { nanoid } from 'nanoid';
import md5 from 'md5';

export async function translate(text, from, to, options = {}) {
    const { config } = options;

    const { appid, secret } = config;

    const url = 'https://fanyi-api.baidu.com/api/trans/vip/translate';

    const salt = nanoid();
    if (options.dictionary && options.context) text = text + '\n' + options.context;
    if (appid === '' || secret === '') {
        throw 'Please configure appid and secret';
    }

    const str = appid + text + salt + secret;
    const sign = md5(str);

    let res = await fetch(url, {
        query: {
            q: text,
            from: from,
            to: to,
            appid: appid,
            salt: salt,
            sign: sign,
        },
    });
    if (res.ok) {
        let result = res.data;
        let target = '';

        const { trans_result } = result;
        if (trans_result) {
            if (options.dictionary) return { senses: [{ definition: trans_result[0]?.dst || '' }],
                contextTranslation: trans_result.slice(1).map(item => item.dst).join('\n') || null };
            for (let i in trans_result) {
                target = target + trans_result[i]['dst'] + '\n';
            }
            return target.trim();
        } else {
            throw JSON.stringify(result);
        }
    } else {
        throw `Http Request Error\nHttp Status: ${res.status}\n${JSON.stringify(res.data)}`;
    }
}

export * from './Config';
export * from './info';
