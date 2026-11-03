import { useVoice } from '../hooks';
import * as ttsServices from '../services/tts';
import { canSpeak, speak } from './systemSpeech';
import { invoke_plugin } from '../utils/invoke_plugin';
import { store } from '../utils/store';

async function remoteAudio(result, language) {
    const instance = ((await store.get('tts_service_list')) || ['lingva_tts'])[0];
    if (!instance) throw new Error('请先配置发音服务');
    const name = instance.split('@')[0],
        config = (await store.get(instance)) || {};
    if (name.startsWith('plugin')) {
        const [tts, utils] = await invoke_plugin('tts', name);
        return tts(result.word, language, { config, utils });
    }
    const service = ttsServices[name];
    if (!service?.tts) throw new Error('发音服务不可用');
    return service.tts(result.word, service.Language?.[language] || language, { config });
}

export function usePronunciation() {
    const play = useVoice();
    return async (result) => {
        const language = result.sourceLanguage === 'auto' ? 'en' : result.sourceLanguage;
        let data;
        try {
            data = await remoteAudio(result, language);
        } catch (error) {
            // The bundled Lingva endpoint is gone, so fall back to the offline
            // Windows voice instead of failing without any sound at all.
            if (!canSpeak()) throw error;
            await speak(result.word, language);
            return;
        }
        if (!data?.length) {
            if (canSpeak()) {
                await speak(result.word, language);
                return;
            }
            throw new Error('发音服务没有返回音频');
        }
        play(data);
    };
}
