import React, { useEffect, useState, useRef } from 'react';
import { appCacheDir, join } from '@tauri-apps/api/path';
import { currentMonitor } from '@tauri-apps/api/window';
import { convertFileSrc } from '@tauri-apps/api/tauri';
import { appWindow } from '@tauri-apps/api/window';
import { emit } from '@tauri-apps/api/event';
import { warn } from 'tauri-plugin-log-api';
import { invoke } from '@tauri-apps/api';
import { relativeSelection } from '../../hover/core';

export default function Screenshot() {
    const [imgurl, setImgurl] = useState('');
    const [isMoved, setIsMoved] = useState(false);
    const [isDown, setIsDown] = useState(false);
    const [mouseDownX, setMouseDownX] = useState(0);
    const [mouseDownY, setMouseDownY] = useState(0);
    const [mouseMoveX, setMouseMoveX] = useState(0);
    const [mouseMoveY, setMouseMoveY] = useState(0);

    const imgRef = useRef();
    const monitorRef = useRef();
    const dragTimer = useRef(null);
    const finishing = useRef(false);
    const nativeDrag = useRef(false);

    useEffect(() => () => clearInterval(dragTimer.current), []);
    async function finishArea(area) {
        if (finishing.current) return;
        finishing.current = true;
        clearInterval(dragTimer.current);
        await appWindow.hide();
        try {
            if (area?.width > 0 && area?.height > 0) {
                await invoke('cut_image', area);
                await emit('success');
            }
        } finally {
            if (nativeDrag.current) await invoke('hover_drag_finished');
            await appWindow.close();
        }
    }
    async function startNativeDrag() {
        const initial = await invoke('hover_drag_state');
        if (!initial?.started) return;
        nativeDrag.current = true;
        let polling = false;
        const update = async () => {
            if (polling || finishing.current) return;
            polling = true;
            try {
                const drag = await invoke('hover_drag_state');
                if (!drag || drag.cancelled) return await finishArea(null);
                const monitor = monitorRef.current;
                const scale = monitor.scaleFactor;
                setIsDown(true); setIsMoved(true);
                setMouseDownX((drag.start.x - monitor.position.x) / scale);
                setMouseDownY((drag.start.y - monitor.position.y) / scale);
                setMouseMoveX((drag.current.x - monitor.position.x) / scale);
                setMouseMoveY((drag.current.y - monitor.position.y) / scale);
                if (drag.end) await finishArea(relativeSelection(drag.start, drag.end, {
                    x: monitor.position.x, y: monitor.position.y,
                    width: imgRef.current.naturalWidth, height: imgRef.current.naturalHeight,
                }));
            } finally { polling = false; }
        };
        dragTimer.current = setInterval(update, 32);
        await update();
    }

    useEffect(() => {
        currentMonitor().then((monitor) => {
            monitorRef.current = monitor;
            const position = monitor.position;
            invoke('screenshot', { x: position.x, y: position.y }).then(() => {
                appCacheDir().then((appCacheDirPath) => {
                    join(appCacheDirPath, 'pot_screenshot.png').then((filePath) => {
                        setImgurl(convertFileSrc(filePath));
                    });
                });
            });
        });
    }, []);

    return (
        <>
            <img
                ref={imgRef}
                className='fixed top-0 left-0 w-full select-none'
                src={imgurl}
                draggable={false}
                onLoad={() => {
                    if (imgurl !== '' && imgRef.current.complete) {
                        void appWindow.show();
                        void appWindow.setFocus();
                        void appWindow.setResizable(false);
                        void startNativeDrag();
                    }
                }}
            />
            <div
                className={`fixed bg-[#2080f020] border border-solid border-sky-500 ${!isMoved && 'hidden'}`}
                style={{
                    top: Math.min(mouseDownY, mouseMoveY),
                    left: Math.min(mouseDownX, mouseMoveX),
                    bottom: screen.height - Math.max(mouseDownY, mouseMoveY),
                    right: screen.width - Math.max(mouseDownX, mouseMoveX),
                }}
            />
            <div
                className='fixed top-0 left-0 bottom-0 right-0 cursor-crosshair select-none'
                onMouseDown={(e) => {
                    if (e.buttons === 1) {
                        setIsDown(true);
                        setMouseDownX(e.clientX);
                        setMouseDownY(e.clientY);
                    } else {
                        void appWindow.close();
                    }
                }}
                onMouseMove={(e) => {
                    if (isDown) {
                        setIsMoved(true);
                        setMouseMoveX(e.clientX);
                        setMouseMoveY(e.clientY);
                    }
                }}
                onMouseUp={async (e) => {
                    if (nativeDrag.current) return;
                    setIsDown(false);
                    setIsMoved(false);
                    const imgWidth = imgRef.current.naturalWidth;
                    const dpi = monitorRef.current?.scaleFactor || imgWidth / screen.width;
                    const left = Math.floor(Math.min(mouseDownX, e.clientX) * dpi);
                    const top = Math.floor(Math.min(mouseDownY, e.clientY) * dpi);
                    const right = Math.floor(Math.max(mouseDownX, e.clientX) * dpi);
                    const bottom = Math.floor(Math.max(mouseDownY, e.clientY) * dpi);
                    const width = right - left;
                    const height = bottom - top;
                    if (width <= 0 || height <= 0) {
                        warn('Screenshot area is too small');
                        await finishArea(null);
                    } else {
                        await finishArea({ left, top, width, height });
                    }
                }}
            />
        </>
    );
}
