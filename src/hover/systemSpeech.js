// Offline pronunciation through the WebView2 speech synthesizer. The online
// Lingva endpoint is unreachable, so a word must still be readable out loud
// without any network call.
export function canSpeak() {
    return typeof window !== 'undefined' &&
        typeof window.speechSynthesis?.speak === 'function' &&
        typeof window.SpeechSynthesisUtterance === 'function';
}

function normalizeLanguage(language) {
    const value = String(language ?? '').replace('_', '-');
    return /^[a-z]{2}(-[A-Za-z]{2,4})?$/u.test(value) ? value : 'en-US';
}

function availableVoices() {
    try {
        return window.speechSynthesis.getVoices() ?? [];
    } catch {
        return [];
    }
}

export function speak(text, language) {
    if (!canSpeak()) return Promise.reject(new Error('System speech synthesis is unavailable'));
    const utterance = new window.SpeechSynthesisUtterance(String(text ?? ''));
    utterance.lang = normalizeLanguage(language);
    const prefix = utterance.lang.slice(0, 2).toLowerCase();
    const voices = availableVoices();
    utterance.voice = voices.find((voice) => voice.lang.replace('_', '-').toLowerCase() === utterance.lang.toLowerCase()) ||
        voices.find((voice) => voice.lang.toLowerCase().startsWith(prefix)) || null;
    window.speechSynthesis.cancel();
    return new Promise((resolve, reject) => {
        utterance.onend = () => resolve();
        utterance.onerror = () => reject(new Error('System speech synthesis failed'));
        window.speechSynthesis.speak(utterance);
    });
}
