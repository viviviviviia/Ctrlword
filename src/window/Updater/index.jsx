import React, { useEffect } from 'react';
import { Button, Card, CardBody } from '@nextui-org/react';
import { appWindow } from '@tauri-apps/api/window';
export default function Updater() {
    useEffect(() => {
        void appWindow.show();
    }, []);
    return (
        <Card className='h-screen'>
            <CardBody className='p-8 justify-center gap-5'>
                <h1 className='text-2xl font-semibold'>Ctrlword 更新</h1>
                <p>当前版本通过安装包手动更新。此应用不会安装 Pot 的官方更新，以免覆盖悬浮词典功能。</p>
                <p className='text-sm text-default-500'>更新前请保留本地生词数据。开发进度和构建说明随项目源码提供。</p>
                <Button onPress={() => appWindow.close()}>关闭</Button>
            </CardBody>
        </Card>
    );
}
