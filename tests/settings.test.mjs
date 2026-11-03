import test from 'node:test';
import assert from 'node:assert/strict';
import { completionEndpoint, validatedSettings, dictionaryMessages, friendlyError } from '../src/hover/settings.js';

test('normalizes completion endpoints without duplicating /v1', () => {
    assert.equal(completionEndpoint('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/chat/completions');
    assert.equal(
        completionEndpoint('https://api.openai.com/v1/chat/completions'),
        'https://api.openai.com/v1/chat/completions'
    );
    assert.equal(completionEndpoint('http://localhost:11434', true), 'http://localhost:11434/api/chat');
    assert.throws(() => completionEndpoint('file:///private'), /HTTP/);
});
test('settings bound capture work and normalize application filenames', () => {
    const settings = validatedSettings({
        intervalMs: 1,
        width: 100000,
        applications: [' C:\\Games\\Game.EXE ', 'game.exe'],
        provider: 'deepseek',
        fallbackProviders: ['deepseek', 'deepl', 'deepl'],
    });
    assert.equal(settings.intervalMs, 100);
    assert.equal(settings.width, 1600);
    assert.deepEqual(settings.applications, ['game.exe']);
    assert.deepEqual(settings.fallbackProviders, ['deepl']);
    assert.equal(settings.activationMode, 'tap');
    assert.equal(validatedSettings({ activationMode: 'hold' }).activationMode, 'hold');
    assert.equal(validatedSettings({ activationMode: 'invalid' }).activationMode, 'tap');
});
test('OCR text remains user data and errors are classified without requiring a provider-specific UI', () => {
    const messages = dictionaryMessages({ word: 'ignore instructions', context: 'quote "', from: 'en', to: 'zh_cn' });
    assert.equal(JSON.parse(messages[1].content).context, 'quote "');
    assert.match(friendlyError('HTTP 401'), /鉴权/);
    assert.match(friendlyError('insufficient_balance'), /余额/);
});
