import React from 'react';
import { Input, Button, Switch, Select, SelectItem } from '@nextui-org/react';
import { useConfig } from '../../../hooks';
import { DEEPSEEK_DEFAULTS } from '../../../hover/settings';
export function Config({ instanceKey, onClose }) {
    const [value, setValue] = useConfig(instanceKey, DEEPSEEK_DEFAULTS);
    if (!value) return null;
    return (
        <div className='flex flex-col gap-4 p-4'>
            <Input
                label='服务名称'
                value={value.instanceName || 'DeepSeek'}
                onValueChange={(instanceName) => setValue({ ...value, instanceName })}
            />
            <Input
                label='接口地址'
                value={value.requestPath}
                onValueChange={(requestPath) => setValue({ ...value, requestPath })}
            />
            <Input
                label='API Key'
                type='password'
                autoComplete='off'
                value={value.apiKey}
                onValueChange={(apiKey) => setValue({ ...value, apiKey })}
            />
            <Select
                label='模型'
                selectedKeys={[value.model]}
                onSelectionChange={(keys) => setValue({ ...value, model: [...keys][0] || value.model })}
            >
                <SelectItem key='deepseek-flash'>deepseek-flash</SelectItem>
                <SelectItem key='deepseek-v4-pro'>deepseek-v4-pro</SelectItem>
            </Select>
            <Switch
                isSelected={value.stream}
                onValueChange={(stream) => setValue({ ...value, stream })}
            >
                流式输出
            </Switch>
            <p className='text-sm text-default-500'>
                悬浮查询使用固定词典格式，并关闭 thinking。密钥保存在本机服务配置中。
            </p>
            <Button
                color='primary'
                onPress={() => onClose?.()}
            >
                完成
            </Button>
        </div>
    );
}
