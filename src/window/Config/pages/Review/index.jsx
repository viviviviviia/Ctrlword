import React, { useEffect, useRef, useState } from 'react';
import { Button, Card, CardBody, Progress } from '@nextui-org/react';
import { dueWords, gradeWord, suspendWord } from '../../../../hover/storage';
import { friendlyError } from '../../../../hover/settings';
import { usePronunciation } from '../../../../hover/usePronunciation';

const grades = ['完全忘记', '看答案才想起', '没答对', '吃力想起', '记得', '轻松记得'];
export default function Review() {
    const [queue, setQueue] = useState([]),
        [revealed, setRevealed] = useState(false),
        [loaded, setLoaded] = useState(false);
    const [error, setError] = useState(''),
        [busy, setBusy] = useState(false),
        [total, setTotal] = useState(0),
        [completed, setCompleted] = useState(0);
    const lock = useRef(false),
        speak = usePronunciation();
    async function refresh() {
        try {
            const words = await dueWords();
            setQueue(words.map((word) => ({ word, practice: Boolean(word.practice_only) })));
            setTotal(words.length);
            setCompleted(0);
            setRevealed(false);
            setError('');
        } catch (error) {
            setError(friendlyError(error));
        } finally {
            setLoaded(true);
        }
    }
    useEffect(() => {
        void refresh();
    }, []);
    const item = queue[0];
    let result = {};
    try {
        result = item ? JSON.parse(item.word.result_json) : {};
    } catch {
        /* The original context remains available. */
    }
    async function grade(quality) {
        if (lock.current || !item || !revealed) return;
        lock.current = true;
        setBusy(true);
        setError('');
        try {
            const updated = await gradeWord(item.word, quality, item.practice);
            setQueue((previous) => {
                const remaining = previous.slice(1);
                if (quality < 4) remaining.push({ word: updated, practice: true });
                return remaining;
            });
            if (quality >= 4) setCompleted((value) => value + 1);
            setRevealed(false);
        } catch (error) {
            setError(friendlyError(error));
        } finally {
            lock.current = false;
            setBusy(false);
        }
    }
    async function pause() {
        if (!item || lock.current) return;
        lock.current = true;
        setBusy(true);
        try {
            await suspendWord(item.word.id, true);
            setQueue((previous) => previous.slice(1));
            setCompleted((value) => value + 1);
            setRevealed(false);
        } catch (error) {
            setError(friendlyError(error));
        } finally {
            lock.current = false;
            setBusy(false);
        }
    }
    return (
        <div className='p-5 flex flex-col gap-5 pb-12'>
            <header>
                <h1 className='text-2xl font-semibold'>间隔复习</h1>
                <p className='text-sm text-default-500 mt-1'>先回忆这个词在原句里的意思，再显示答案并评分。</p>
            </header>
            <Progress
                aria-label='今日复习进度'
                value={total ? Math.min(100, (completed / total) * 100) : 100}
                size='sm'
            />
            <div className='flex justify-between text-xs text-default-500'>
                <span>
                    已完成 {completed} / {total}
                </span>
                <span>队列剩余 {queue.length}</span>
            </div>
            {error && (
                <p
                    role='alert'
                    className='text-danger text-sm'
                >
                    {error}
                </p>
            )}
            {!loaded ? (
                <p>正在读取复习队列…</p>
            ) : !item ? (
                <Card>
                    <CardBody className='p-10 text-center gap-4'>
                        <h2 className='text-xl font-semibold'>今天的复习已完成</h2>
                        <p className='text-default-500'>
                            已根据你的评分安排下次复习。还没有生词时，可以先从悬浮词典收藏。
                        </p>
                        <Button
                            variant='flat'
                            onPress={refresh}
                        >
                            刷新队列
                        </Button>
                    </CardBody>
                </Card>
            ) : (
                <Card>
                    <CardBody className='p-7 gap-5'>
                        <p className='text-xs text-default-400'>
                            {item.practice ? '当日巩固 · 不重复推进长期复习间隔' : 'SM2 间隔复习'}
                        </p>
                        <div className='flex gap-3 items-center'>
                            <h2 className='text-4xl font-semibold'>{item.word.word}</h2>
                            <Button
                                size='sm'
                                variant='light'
                                onPress={async () => {
                                    try {
                                        await speak({
                                            ...result,
                                            word: item.word.word,
                                            sourceLanguage: item.word.source_lang,
                                        });
                                    } catch (error) {
                                        setError(friendlyError(error));
                                    }
                                }}
                            >
                                发音
                            </Button>
                        </div>
                        <p className='text-sm text-default-500'>{result.phonetics?.join(' · ')}</p>
                        <blockquote className='border-l-2 border-default-200 pl-4 text-default-600'>
                            {item.word.context}
                        </blockquote>
                        {!revealed ? (
                            <Button
                                color='primary'
                                onPress={() => setRevealed(true)}
                            >
                                显示释义
                            </Button>
                        ) : (
                            <>
                                <div className='border-t border-default-200 pt-4 flex flex-col gap-2'>
                                    {(result.senses || []).map((sense, index) => (
                                        <p key={index}>
                                            <span className='text-sm text-default-400 mr-2'>{sense.partOfSpeech}</span>
                                            {sense.definition}
                                        </p>
                                    ))}
                                    {result.contextTranslation && (
                                        <p className='text-sm text-default-500 mt-2'>{result.contextTranslation}</p>
                                    )}
                                </div>
                                <div className='grid grid-cols-3 gap-2'>
                                    {grades.map((label, quality) => (
                                        <Button
                                            key={quality}
                                            size='sm'
                                            color={quality < 3 ? 'default' : 'primary'}
                                            variant={quality === 4 ? 'solid' : 'flat'}
                                            isDisabled={busy}
                                            onPress={() => grade(quality)}
                                        >
                                            {quality} · {label}
                                        </Button>
                                    ))}
                                </div>
                            </>
                        )}
                        <Button
                            variant='light'
                            size='sm'
                            isDisabled={busy}
                            onPress={pause}
                        >
                            暂停学习此词
                        </Button>
                    </CardBody>
                </Card>
            )}
        </div>
    );
}
