import React, { useEffect, useState } from 'react';
import { Card, CardBody, Input, Button, Switch, Select, SelectItem, Textarea } from '@nextui-org/react';
import { useNavigate } from 'react-router-dom';
import { invoke } from '@tauri-apps/api/tauri';
import { emit } from '@tauri-apps/api/event';
import { store } from '../../../../utils/store';
import { HOVER_DEFAULTS, DEEPSEEK_DEFAULTS, validatedSettings, friendlyError } from '../../../../hover/settings';
import { providerList, lookupDictionary } from '../../../../hover/adapters';
import { clearCache } from '../../../../hover/storage';

const names = {
    deepseek: 'DeepSeek',
    deepl: 'DeepL',
    caiyun: '彩云小译',
    baidu: '百度翻译',
    openai: 'OpenAI',
    ollama: 'Ollama',
};
export default function HoverSettings() {
    const [form, setForm] = useState(null),
        [deepseek, setDeepseek] = useState(DEEPSEEK_DEFAULTS);
    const [sources, setSources] = useState([]),
        [status, setStatus] = useState(null),
        [message, setMessage] = useState(''),
        [busy, setBusy] = useState(false);
    const navigate = useNavigate();
    useEffect(() => {
        let active = true;
        Promise.all([store.get('hover_settings'), store.get('deepseek'), providerList()]).then(
            ([settings, api, list]) => {
                if (active) {
                    setForm(validatedSettings(settings || {}));
                    setDeepseek({ ...DEEPSEEK_DEFAULTS, ...api });
                    setSources(list);
                }
            }
        );
        const update = () =>
            invoke('hover_status')
                .then((value) => active && setStatus(value))
                .catch(() => {});
        update();
        const timer = setInterval(update, 2000);
        return () => {
            active = false;
            clearInterval(timer);
        };
    }, []);
    if (!form) return <p className='p-5'>正在读取设置…</p>;
    const change = (key, value) => setForm((previous) => ({ ...previous, [key]: value }));
    const select = (key, label, options) => (
        <Select
            label={label}
            selectedKeys={[form[key]]}
            onSelectionChange={(keys) => change(key, [...keys][0] || form[key])}
        >
            {options.map(([value, name]) => (
                <SelectItem key={value}>{name}</SelectItem>
            ))}
        </Select>
    );
    const number = (key, label) => (
        <Input
            type='number'
            label={label}
            value={String(form[key])}
            onValueChange={(value) => change(key, value)}
        />
    );
    async function save() {
        const settings = validatedSettings(form);
        await store.set('hover_settings', settings);
        await store.set('deepseek', deepseek);
        const current = (await store.get('translate_service_list')) || [
            'deepl',
            'bing',
            'lingva',
            'yandex',
            'google',
            'ecdict',
        ];
        if (!current.includes('deepseek')) await store.set('translate_service_list', [...current, 'deepseek']);
        await store.save();
        await invoke('reload_store');
        await emit('hover_settings_changed', settings);
        if (!settings.enabled) await invoke('hover_close');
        setForm(settings);
        return settings;
    }
    async function run(action) {
        setBusy(true);
        setMessage('');
        try {
            await action();
        } catch (error) {
            setMessage(friendlyError(error));
        } finally {
            setBusy(false);
        }
    }
    function move(index, direction) {
        const list = [...form.fallbackProviders];
        const next = index + direction;
        if (next < 0 || next >= list.length) return;
        [list[index], list[next]] = [list[next], list[index]];
        change('fallbackProviders', list);
    }
    return (
        <div className='flex flex-col gap-4 p-4 pb-12'>
            <div>
                <h1 className='text-2xl font-semibold'>Ctrl 悬浮词典</h1>
                <p className='text-sm text-default-500 mt-1'>
                    鼠标指向单词或单词下沿，轻按一次触发键（默认左 Ctrl）即可取词。再次轻按、按 Esc 或移开鼠标关闭；按住并拖动仍可框选翻译。
                </p>
            </div>
            <Card>
                <CardBody className='gap-4'>
                    <Switch
                        isSelected={form.enabled}
                        onValueChange={(value) => change('enabled', value)}
                    >
                        启用全局悬浮 OCR 取词翻译（修改后点击保存）
                    </Switch>
                    <div className='grid grid-cols-2 gap-3'>
                        {select('activationMode', '触发方式', [
                            ['tap', '轻按一次（推荐）'],
                            ['hold', '按住悬浮（旧方式）'],
                        ])}
                        {select('trigger', '触发键', [
                            ['LeftControl', '左 Ctrl'],
                            ['RightControl', '右 Ctrl'],
                            ['LeftAlt', '左 Alt'],
                            ['RightAlt', '右 Alt'],
                            ['LeftShift', '左 Shift'],
                        ])}
                        {number('intervalMs', '按住模式采样间隔（毫秒）')}
                        {number('width', '识别框宽度（逻辑像素）')}
                        {number('height', '识别框高度（逻辑像素）')}
                        {number('offsetX', '水平偏移')}
                        {number('offsetY', '垂直偏移')}
                        {select('ocrEngine', 'OCR 引擎', [
                            ['auto', 'Windows 优先，失败回退 Tesseract'],
                            ['system', '仅 Windows 系统 OCR'],
                            ['tesseract', '仅 Tesseract（本地）'],
                        ])}
                        {select('ocrLanguage', '识别语言', [
                            ['auto', '系统自动 / 本地中英'],
                            ['en-US', '英语'],
                            ['zh-Hans-CN', '简体中文'],
                        ])}
                    </div>
                    <Switch
                        isSelected={form.expandContext}
                        onValueChange={(value) => change('expandContext', value)}
                    >
                        局部扩大截图，补全单词和上下文
                    </Switch>
                    <p className='text-xs text-default-500'>
                        轻按模式不等待采样间隔，松开按键后继续查询。可把鼠标放在词下沿约 12 像素内；截图本身不含光标。
                        补全上下文开启时合并为一次局部 OCR。空白或无效识别不会调用翻译。系统 OCR
                        依赖已安装语言；英文文献建议选择“英语”，系统自动会沿用 Windows 用户语言。本地回退内置英语和简体中文资源。
                    </p>
                </CardBody>
            </Card>
            <Card>
                <CardBody className='gap-4'>
                    <h2 className='font-semibold'>翻译与备用源</h2>
                    <div className='grid grid-cols-2 gap-3'>
                        {select(
                            'provider',
                            '优先翻译服务',
                            sources.map((source) => [source, names[source] || source])
                        )}
                        {select('targetLanguage', '译为', [
                            ['zh_cn', '简体中文'],
                            ['zh_tw', '繁体中文'],
                            ['en', '英语'],
                            ['ja', '日语'],
                            ['ko', '韩语'],
                            ['fr', '法语'],
                            ['de', '德语'],
                            ['es', '西班牙语'],
                            ['ru', '俄语'],
                        ])}
                        {number('timeoutMs', '单个服务超时（毫秒）')}
                        <Button
                            variant='flat'
                            onPress={() => navigate('/service')}
                        >
                            配置其他服务商 / 插件
                        </Button>
                    </div>
                    <div>
                        <p className='text-sm mb-2'>备用顺序</p>
                        {form.fallbackProviders.map((source, index) => (
                            <div
                                key={source}
                                className='flex items-center gap-2 mb-1'
                            >
                                <span className='flex-1 text-sm'>
                                    {index + 1}. {names[source] || source}
                                </span>
                                <Button
                                    size='sm'
                                    isIconOnly
                                    aria-label='上移'
                                    onPress={() => move(index, -1)}
                                >
                                    ↑
                                </Button>
                                <Button
                                    size='sm'
                                    isIconOnly
                                    aria-label='下移'
                                    onPress={() => move(index, 1)}
                                >
                                    ↓
                                </Button>
                                <Button
                                    size='sm'
                                    variant='light'
                                    onPress={() =>
                                        change(
                                            'fallbackProviders',
                                            form.fallbackProviders.filter((item) => item !== source)
                                        )
                                    }
                                >
                                    移除
                                </Button>
                            </div>
                        ))}
                        <select
                            className='w-full p-2 border border-default-200 rounded-lg bg-content1 text-sm'
                            value=''
                            onChange={(event) => {
                                if (event.target.value)
                                    change('fallbackProviders', [...form.fallbackProviders, event.target.value]);
                            }}
                        >
                            <option value=''>添加备用翻译源…</option>
                            {sources
                                .filter(
                                    (source) => source !== form.provider && !form.fallbackProviders.includes(source)
                                )
                                .map((source) => (
                                    <option
                                        key={source}
                                        value={source}
                                    >
                                        {names[source] || source}
                                    </option>
                                ))}
                        </select>
                    </div>
                    <p className='text-xs text-default-500'>
                        超时、鉴权、额度或接口错误时依次尝试备用源。普通翻译接口可能不提供音标和例句；彩云、百度的上下文随批量文本发送，不保证具有大模型同等的语境消歧能力。
                    </p>
                </CardBody>
            </Card>
            <Card>
                <CardBody className='gap-3'>
                    <h2 className='font-semibold'>DeepSeek</h2>
                    <Input
                        label='接口地址'
                        value={deepseek.requestPath}
                        onValueChange={(requestPath) => setDeepseek({ ...deepseek, requestPath })}
                    />
                    <Input
                        label='API Key'
                        type='password'
                        autoComplete='off'
                        value={deepseek.apiKey}
                        onValueChange={(apiKey) => setDeepseek({ ...deepseek, apiKey })}
                    />
                    <Select
                        label='模型'
                        selectedKeys={[deepseek.model]}
                        onSelectionChange={(keys) =>
                            setDeepseek({ ...deepseek, model: [...keys][0] || deepseek.model })
                        }
                    >
                        <SelectItem key='deepseek-flash'>deepseek-flash</SelectItem>
                        <SelectItem key='deepseek-v4-pro'>deepseek-v4-pro</SelectItem>
                    </Select>
                    <Switch
                        isSelected={deepseek.stream}
                        onValueChange={(stream) => setDeepseek({ ...deepseek, stream })}
                    >
                        流式词典结果（thinking 已关闭）
                    </Switch>
                </CardBody>
            </Card>
            <Card>
                <CardBody className='gap-3'>
                    <h2 className='font-semibold'>应用规则</h2>
                    {select('appMode', '规则模式', [
                        ['blacklist', '黑名单：以下程序不启用'],
                        ['whitelist', '白名单：只在以下程序启用'],
                    ])}
                    <Textarea
                        label='程序名称，每行一个'
                        placeholder={'game.exe\nexample.exe'}
                        value={form.applications.join('\n')}
                        onValueChange={(value) => change('applications', value.split('\n'))}
                    />
                    <p className='text-xs text-default-500'>
                        填写可执行文件名，例如 game.exe。白名单为空时不会在任何程序中启用。
                    </p>
                </CardBody>
            </Card>
            <div className='flex gap-2 flex-wrap'>
                <Button
                    color='primary'
                    isLoading={busy}
                    onPress={() =>
                        run(async () => {
                            await save();
                            setMessage('设置已保存');
                        })
                    }
                >
                    保存设置
                </Button>
                <Button
                    variant='flat'
                    isDisabled={busy}
                    onPress={() =>
                        run(async () => {
                            const settings = await save();
                            const result = await lookupDictionary(
                                { word: 'example', context: 'This is an example.' },
                                settings
                            );
                            setMessage(`连接成功 · ${result.provider}：${result.senses[0].definition}`);
                        })
                    }
                >
                    保存并测试当前服务
                </Button>
                <Button
                    variant='light'
                    isDisabled={busy}
                    onPress={() =>
                        run(async () => {
                            await clearCache();
                            setMessage('翻译缓存已清空，生词和复习记录保留');
                        })
                    }
                >
                    清空翻译缓存
                </Button>
            </div>
            {message && (
                <p
                    role='status'
                    className='text-sm whitespace-pre-wrap'
                >
                    {message}
                </p>
            )}
            <p className='text-xs text-default-400'>
                {status?.supported
                    ? `后台${status.ready ? '已就绪' : '初始化中'} · 取词任务 ${status.probes} · 局部截图 ${status.captures}`
                    : '此功能当前仅支持 Windows'}
                {status?.lastError && ` · ${status.lastError}`}
                {status?.timings?.popupMs != null && ` · 最近弹窗 ${status.timings.popupMs}ms`}
                {status?.timings?.firstDefinitionMs != null && ` · 首条释义 ${status.timings.firstDefinitionMs}ms`}
            </p>
        </div>
    );
}
