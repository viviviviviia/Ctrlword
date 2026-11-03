# Ctrlword

Windows 全局悬浮词典：指向单词轻按一次左 Ctrl，在鼠标旁显示释义、整句翻译与发音。
仓库：<https://github.com/viviviviviia/Ctrlword>　许可证：GPL-3.0-only

> 原名 CtrlHoverDict，0.1.7 起对外名称改为 **Ctrlword**；程序内部标识符（io.ctrlhoverdict.desktop、ctrlhoverdict.db）保持不变，以免用户配置与生词本丢失。基于 [Pot](https://github.com/pot-app/pot-desktop) 二次开发。

鼠标指向单词或其下沿空白，轻按并松开左 Ctrl：局部截图 → 本地 OCR → 带上下文翻译 → 非激活词典卡片。
按住触发键并拖动可框选翻译；收藏的单词可在本地生词本中按 SM2 复习。

## 安装

到 [Releases](https://github.com/viviviviviia/Ctrlword/releases) 下载 `Ctrlword_<版本>_x64-setup.exe`，双击安装，默认装到当前用户目录，无需管理员权限。
重装前请先退出程序，否则安装器不会覆盖正在运行的 exe。

## 开发与构建

本机验证环境：Windows x64、Node 24、pnpm 9.15.9、Rust 1.99.1、Visual Studio C++ Build Tools 2022、Windows SDK 10.0.26100、WebView2。

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm tauri dev
pnpm tauri build
```

项目固定 pnpm 版本。Tauri 启动器会查找用户目录的 `.cargo/bin`，无需为此修改系统 PATH。
Windows 构建目标为当前用户安装的 NSIS exe。Rust 测试运行 `cargo test --manifest-path src-tauri/Cargo.toml`。
测试使用 Node 内置 SQLite，因此建议使用 Node 24。

## 首次配置

1. 打开“悬浮词典”，在本机输入 DeepSeek Key，选择模型；也可在“服务设置”配置 DeepL、彩云、百度、OpenAI 或 Ollama。
2. 设置优先服务和备用顺序，保存并测试。云 API 按服务商规则计费；软件本身免费。
3. 打开悬浮取词开关并保存。默认左 Ctrl、250ms、100×40 小框；识别后可局部补全上下文。
4. 切回阅读软件，指向单词或词下沿并轻按一次触发键。可以移入卡片点击按钮，再次轻按、Esc 或移出目标和卡片关闭。设置可切回旧按住模式。

不要把 Key 写进源码或提交到 Git。Key 只保存在本机的用户配置文件里，请自行保管该目录。

## 功能与边界

- Windows 系统 OCR 优先，本地 Tesseract 回退；已内置英语和简体中文回退资源。
- 六家翻译服务统一词典结构，LLM 服务支持流式；传统接口缺少的音标、搭配或例句保持为空。
- 成功结果本地缓存，重复请求合并，异常按顺序切换备用服务；重译主动绕过缓存。
- 生词只在主动收藏时保存；SM2 及当日巩固持久化，重复收藏不重置进度。
- 触发键、框大小、间隔、OCR、应用黑白名单均可配置。
- 保留 Pot 的划词、普通截图、历史、TTS 和插件能力。

各阅读软件、多显示器混合 DPI、卡片点击不抢焦点等交互需在实际使用中验证；真实翻译服务与 TTS 需要你自己配置 Key 后确认。

## 数据

应用标识为 `io.ctrlhoverdict.desktop`，与原 Pot 隔离。Windows 配置及数据库通常在
`%APPDATA%/io.ctrlhoverdict.desktop/`，包含 `ctrlhoverdict.db`；备份时保留整个应用数据目录。
此 fork 已关闭 Pot 官方自动更新，避免被上游安装包覆盖。

上游提交为 `594d32ede96acd106b0256deaa8bb440ffcdff40`；第三方来源和许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
