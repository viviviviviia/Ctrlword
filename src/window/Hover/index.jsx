import React, { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import { listen } from '@tauri-apps/api/event';
import { writeText } from '@tauri-apps/api/clipboard';
import { store } from '../../utils/store';
import { lookupDictionary, providerList } from '../../hover/adapters';
import { recognizeQuick, recognizeTarget } from '../../hover/ocr';
import { validatedSettings, friendlyError } from '../../hover/settings';
import { saveWord } from '../../hover/storage';
import { usePronunciation } from '../../hover/usePronunciation';
import './style.css';

export default function Hover() {
    const [view, setView] = useState(null),
        [providers, setProviders] = useState([]),
        [notice, setNotice] = useState('');
    const current = useRef(null),
        controller = useRef(null),
        card = useRef(null),
        drag = useRef(null);
    const speak = usePronunciation();
    async function translate(target, id, settings, provider, force = false) {
        controller.current?.abort();
        const task = new AbortController();
        controller.current = task;
        current.current = { target, id, settings, provider };
        setView({ id, target, provider, loading: true, data: null, error: '', failures: [] });
        setNotice('');
        try {
            const result = await lookupDictionary(target, settings, {
                sessionId: id,
                signal: task.signal,
                provider,
                force,
                onProvider: (provider, failures) => {
                    if (!task.signal.aborted)
                        setView((value) => (value?.id === id ? { ...value, provider, failures, data: null } : value));
                },
                onPartial: (data) => {
                    if (!task.signal.aborted) {
                        if (data.senses?.length) void invoke('hover_timing', { id, phase: 'firstDefinitionMs' });
                        setView((value) => (value?.id === id ? { ...value, data } : value));
                    }
                },
            });
            if (!task.signal.aborted)
                void invoke('hover_timing', { id, phase: 'firstDefinitionMs' });
            if (!task.signal.aborted)
                void invoke('hover_timing', { id, phase: 'completeMs' });
            if (!task.signal.aborted)
                setView((value) =>
                    value?.id === id ? { ...value, data: result, provider: result.provider, loading: false } : value
                );
        } catch (error) {
            if (!task.signal.aborted && !/cancel/iu.test(String(error)))
                setView((value) =>
                    value?.id === id ? { ...value, loading: false, error: friendlyError(error) } : value
                );
        }
    }
    useEffect(() => {
        let disposed = false,
            processing = false,
            latest = null;
        const unsubscribers = [];
        const cancel = () => {
            latest = null;
            controller.current?.abort();
            current.current = null;
            setView(null);
            setNotice('');
        };
        const process = async (payload) => {
            if (disposed) return;
            if (processing) {
                void invoke('hover_trace', { message: `busy ${payload.id}` }).catch(() => {});
                controller.current?.abort();
                latest = payload;
                return;
            }
            processing = true;
            const task = new AbortController();
            controller.current?.abort();
            controller.current = task;
            const trace = (message) => void invoke('hover_trace', { message }).catch(() => {});
            trace(`probe ${payload.id}`);
            try {
                const settings = validatedSettings((await store.get('hover_settings')) || {});
                if (!settings.enabled || task.signal.aborted) return;
                // The word from the small crop appears first; the wide sentence
                // frame is several times slower and must not hold the popup back.
                const quick = await recognizeQuick(payload.id, task.signal);
                trace(`quick ${quick ? quick.word : 'none'} ${payload.id}${task.signal.aborted ? ' aborted' : ''}`);
                if (task.signal.aborted || disposed) return;
                if (quick) {
                    if (!(await invoke('hover_target', { id: payload.id, rect: quick.rect }))) return;
                    setView({
                        id: payload.id,
                        target: quick,
                        provider: settings.provider,
                        loading: true,
                        data: null,
                        error: '',
                        failures: [],
                        preview: true,
                    });
                }
                const target = settings.expandContext
                    ? (await recognizeTarget(payload.id, settings, task.signal)) || quick
                    : quick;
                trace(`target ${target ? target.word : 'none'} ${payload.id}`);
                if (!target || task.signal.aborted || disposed) return;
                if (target !== quick && !(await invoke('hover_target', { id: payload.id, rect: target.rect }))) return;
                // Recognition is finished before any window or translation request is started.
                await translate(target, payload.id, settings, settings.provider);
            } catch (error) {
                trace(`error ${String(error)} ${payload.id}`);
                /* Empty, invalid, stale or failed OCR stays silent and does not call an API. */
            } finally {
                trace(`done ${payload.id}`);
                processing = false;
                if (latest && !disposed) {
                    const next = latest;
                    latest = null;
                    void process(next);
                }
            }
        };
        (async () => {
            const add = async (name, callback) => {
                const unlisten = await listen(name, callback);
                if (disposed) unlisten();
                else unsubscribers.push(unlisten);
            };
            await add('chd:cancel', cancel);
            await add('chd:probe', (event) => {
                void process(event.payload);
            });
            if (disposed) return;
            setProviders(await providerList());
            if (!disposed) await invoke('hover_ready');
        })();
        return () => {
            disposed = true;
            cancel();
            unsubscribers.forEach((unlisten) => unlisten());
        };
    }, []);
    useEffect(() => {
        if (!view || !card.current) return;
        let frame;
        let previousHeight;
        const show = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
                const element = card.current;
                if (!element) return;
                // The card is constrained by the current viewport. Measure its natural
                // contents instead, otherwise the initial loading window caps all later
                // streamed results and ResizeObserver cannot grow it again.
                const height = Math.ceil(
                    [...element.children].reduce(
                        (total, child) => total + (child.tagName === 'MAIN' ? child.scrollHeight : child.offsetHeight),
                        2
                    )
                );
                const boundedHeight = Math.max(130, Math.min(620, height));
                if (boundedHeight === previousHeight) return;
                previousHeight = boundedHeight;
                void invoke('hover_show', { id: view.id, height: boundedHeight }).catch(() => {});
            });
        };
        const observer = new ResizeObserver(show);
        for (const child of card.current.children) observer.observe(child);
        show();
        return () => {
            observer.disconnect();
            cancelAnimationFrame(frame);
        };
    }, [view?.id, view?.data, view?.loading, view?.error, notice]);
    async function action(fn) {
        try {
            await fn();
        } catch (error) {
            setNotice(friendlyError(error));
        }
    }
    // The popup never takes focus, so moving it is plain pointer tracking: the
    // native side keeps the outer corner from the first click and applies the
    // offset in physical pixels.
    function startDrag(event) {
        if (event.button !== 0) return;
        if (event.target.closest?.('button, a, input, select, textarea')) return;
        drag.current = { x: event.screenX, y: event.screenY };
        try {
            event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
            /* Pointer capture is best effort. */
        }
        void invoke('hover_popup_drag_begin').catch(() => {
            drag.current = null;
        });
    }
    function moveDrag(event) {
        const start = drag.current;
        if (!start) return;
        const scale = window.devicePixelRatio || 1;
        void invoke('hover_popup_drag_move', {
            dx: (event.screenX - start.x) * scale,
            dy: (event.screenY - start.y) * scale,
        }).catch(() => {});
    }
    function endDrag() {
        if (!drag.current) return;
        drag.current = null;
        void invoke('hover_popup_drag_end').catch(() => {});
    }
    if (!view) return null;
    const data = view.data;
    const senses = Array.isArray(data?.senses)
        ? data.senses.filter((item) => typeof item?.definition === 'string')
        : [];
    const examples = Array.isArray(data?.examples)
        ? data.examples.filter((item) => typeof item?.text === 'string')
        : [];
    const collocations = Array.isArray(data?.collocations)
        ? data.collocations.filter((item) => typeof item?.text === 'string')
        : [];
    const copy = () =>
        writeText(
            [
                view.target.word,
                ...senses.map((item) => `${item.partOfSpeech || ''} ${item.definition}`),
                ...examples.map((item) => `${item.text}\n${item.translation || ''}`),
            ].join('\n')
        );
    const retry = (provider) => {
        const item = current.current;
        if (item) void translate(item.target, item.id, item.settings, provider, true);
    };
    return (
        <article
            className='chd-card'
            ref={card}
            aria-label='悬浮词典'
        >
            <header
                onPointerDown={startDrag}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                title='按住此处可拖动窗口'
            >
                <div>
                    <h1>{view.target.word}</h1>
                    <div className='chd-phonetic'>
                        {(Array.isArray(data?.phonetics) ? data.phonetics : [])
                            .filter((item) => typeof item === 'string')
                            .join(' · ')}
                    </div>
                </div>
                <button
                    aria-label='关闭'
                    title='关闭（也可按 Esc）'
                    onClick={() => invoke('hover_close')}
                >
                    ×
                </button>
            </header>
            <main>
                {view.loading && (
                    <div className='chd-loading'>
                        <span className='chd-dot' />
                        {senses.length ? '正在补全词典…' : '正在查询…'}
                    </div>
                )}
                {senses.map((item, index) => (
                    <div
                        className='chd-sense'
                        key={index}
                    >
                        <span>{typeof item.partOfSpeech === 'string' ? item.partOfSpeech : ''}</span>
                        <p>{item.definition}</p>
                    </div>
                ))}
                {collocations.length > 0 && (
                    <section>
                        <h2>常见搭配</h2>
                        {collocations.map((item, index) => (
                            <p key={index}>
                                <strong>{item.text}</strong>
                                {typeof item.translation === 'string' && <span> · {item.translation}</span>}
                            </p>
                        ))}
                    </section>
                )}
                {examples.length > 0 && (
                    <section>
                        <h2>例句</h2>
                        {examples.map((item, index) => (
                            <div
                                className='chd-example'
                                key={index}
                            >
                                <p>{item.text}</p>
                                {typeof item.translation === 'string' && (
                                    <p className='chd-muted'>{item.translation}</p>
                                )}
                            </div>
                        ))}
                    </section>
                )}
                {!view.preview && (
                    <section className='chd-context'>
                        <h2>当前语境</h2>
                        <p>{view.target.context}</p>
                        {typeof data?.contextTranslation === 'string' && (
                            <p className='chd-muted'>{data.contextTranslation}</p>
                        )}
                    </section>
                )}
                {view.failures?.length > 0 && (
                    <details className='chd-muted'>
                        <summary>已切换备用源</summary>
                        {view.failures.map((item) => (
                            <p key={item}>{item}</p>
                        ))}
                    </details>
                )}
                {view.error && (
                    <p
                        className='chd-error'
                        role='alert'
                    >
                        {view.error}
                    </p>
                )}
            </main>
            <footer>
                <div className='chd-tools'>
                    <button
                        disabled={!senses.length || view.loading}
                        onClick={() =>
                            action(async () => {
                                await saveWord(data);
                                setNotice('已加入生词本');
                            })
                        }
                    >
                        ＋ 生词本
                    </button>
                    <button
                        disabled={!data || view.loading}
                        onClick={() => action(() => speak(data))}
                    >
                        ♫ 发音
                    </button>
                    <button
                        disabled={!senses.length}
                        onClick={() =>
                            action(async () => {
                                await copy();
                                setNotice('已复制');
                            })
                        }
                    >
                        复制
                    </button>
                    <button onClick={() => retry(view.provider)}>重译</button>
                </div>
                <div className='chd-source'>
                    <select
                        aria-label='翻译服务'
                        value={view.provider}
                        onChange={(event) => retry(event.target.value)}
                    >
                        {providers.map((provider) => (
                            <option
                                key={provider}
                                value={provider}
                            >
                                {provider}
                            </option>
                        ))}
                    </select>
                    <span>{data?.cached ? '本地缓存' : view.loading ? '查询中' : '词典'}</span>
                </div>
                {notice && (
                    <div
                        className='chd-notice'
                        role='status'
                    >
                        {notice}
                    </div>
                )}
                {data?.cacheWarning && <div className='chd-notice'>{data.cacheWarning}</div>}
            </footer>
        </article>
    );
}
