import React, { useEffect, useState } from 'react';
import { Card, CardBody, Input, Button, Chip } from '@nextui-org/react';
import { useNavigate } from 'react-router-dom';
import { listWords, deleteWord, suspendWord } from '../../../../hover/storage';
import { usePronunciation } from '../../../../hover/usePronunciation';
import { friendlyError } from '../../../../hover/settings';

export default function Vocabulary() {
    const [words, setWords] = useState([]),
        [search, setSearch] = useState(''),
        [error, setError] = useState(''),
        [version, setVersion] = useState(0);
    const navigate = useNavigate(),
        speak = usePronunciation();
    useEffect(() => {
        let active = true;
        const timer = setTimeout(
            () =>
                listWords(search)
                    .then((rows) => {
                        if (active) {
                            setWords(rows);
                            setError('');
                        }
                    })
                    .catch((error) => active && setError(friendlyError(error))),
            150
        );
        return () => {
            active = false;
            clearTimeout(timer);
        };
    }, [search, version]);
    async function action(fn) {
        try {
            await fn();
            setVersion((value) => value + 1);
            setError('');
        } catch (error) {
            setError(friendlyError(error));
        }
    }
    return (
        <div className='p-4 flex flex-col gap-4 pb-12'>
            <header className='flex justify-between items-center'>
                <div>
                    <h1 className='text-2xl font-semibold'>生词本</h1>
                    <p className='text-sm text-default-500 mt-1'>保存你遇到的词，以及当时的语境。</p>
                </div>
                <Button
                    color='primary'
                    onPress={() => navigate('/review')}
                >
                    开始复习
                </Button>
            </header>
            <Input
                aria-label='搜索生词'
                placeholder='搜索单词或上下文'
                value={search}
                onValueChange={setSearch}
                isClearable
            />
            <p className='text-xs text-default-500'>{words.length} 个词条 · 只保存你主动加入的单词</p>
            {error && (
                <p
                    role='alert'
                    className='text-sm text-danger'
                >
                    {error}
                </p>
            )}
            {!words.length && (
                <Card>
                    <CardBody className='p-8 text-center text-default-500'>
                        暂无匹配的词。按住触发键查词后，点击浮窗里的“生词本”即可收藏。
                    </CardBody>
                </Card>
            )}
            {words.map((word) => {
                let result = {};
                try {
                    result = JSON.parse(word.result_json);
                } catch {
                    /* Keep the word visible even if old data is damaged. */
                }
                return (
                    <Card key={word.id}>
                        <CardBody className='gap-3 p-4'>
                            <div className='flex justify-between items-start gap-3'>
                                <div>
                                    <h2 className='text-xl font-semibold'>{word.word}</h2>
                                    <p className='text-xs text-default-500'>{result.phonetics?.join(' · ')}</p>
                                </div>
                                <Chip
                                    size='sm'
                                    variant='flat'
                                >
                                    {word.suspended
                                        ? '已暂停'
                                        : word.repetitions
                                          ? `${word.interval_days} 天间隔`
                                          : '新词'}
                                </Chip>
                            </div>
                            {(result.senses || []).map((sense, index) => (
                                <p key={index}>
                                    <span className='text-default-400 text-xs mr-2'>{sense.partOfSpeech}</span>
                                    {sense.definition}
                                </p>
                            ))}
                            {word.context && (
                                <blockquote className='border-l-2 border-default-200 pl-3 text-sm text-default-500'>
                                    {word.context}
                                    {result.contextTranslation && <p className='mt-1'>{result.contextTranslation}</p>}
                                </blockquote>
                            )}
                            <div className='flex gap-2 items-center flex-wrap'>
                                <Button
                                    size='sm'
                                    variant='flat'
                                    onPress={() =>
                                        action(() =>
                                            speak({ ...result, word: word.word, sourceLanguage: word.source_lang })
                                        )
                                    }
                                >
                                    发音
                                </Button>
                                <Button
                                    size='sm'
                                    variant='light'
                                    onPress={() => action(() => suspendWord(word.id, !word.suspended))}
                                >
                                    {word.suspended ? '恢复学习' : '暂停学习'}
                                </Button>
                                <Button
                                    size='sm'
                                    color='danger'
                                    variant='light'
                                    onPress={() => {
                                        if (window.confirm(`删除“${word.word}”及其复习记录？`))
                                            void action(() => deleteWord(word.id));
                                    }}
                                >
                                    删除
                                </Button>
                                <span className='ml-auto text-xs text-default-400'>
                                    {word.last_reviewed_at
                                        ? `下次 ${new Date(word.due_at).toLocaleDateString()}`
                                        : '尚未复习'}
                                </span>
                            </div>
                        </CardBody>
                    </Card>
                );
            })}
        </div>
    );
}
