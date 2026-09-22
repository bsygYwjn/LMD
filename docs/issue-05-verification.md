# 问题 05：修复及复测记录

2026-09-14。状态：本工作树代码修复、隔离浏览器回归通过；未合入主服务，真实媒体与问题 06 合并后待验收。

工作树：`C:\Users\dytdy\.codex\worktrees\0cc6\LMD本地视频共享`。

## 改动

- CONTROL-01：Escape 在输入控件和面板短路之前处理，优先关闭面板，再退出页面全屏、解锁或关闭弹窗。打开面板聚焦关闭按钮，关闭后恢复原入口；设置内切到弹幕保留原入口。捕获阶段阻止同一次 Escape 继续触发外层监听器。
- CONTROL-02：记录键盘/指针输入方式；指针点击残留焦点不再阻止 2.6 秒闲置隐藏，键盘焦点保持控制栏，Tab/focus 唤回。面板、暂停、进度拖动和触控手势期间不自动隐藏。
- CONTROL-03：页面模式仅保留底部剧集导航；全屏和弹窗使用控制条入口。按钮、媒体键与自动结束统一调用一次性下一集回调，同一 media.id 不重复触发，切换媒体后重置。
- 快捷键：空格保留按钮/链接/summary 原生激活行为；Space、F、M 不因 repeat 连续切换。输入/文本框/下拉框/contenteditable 不触发播放器快捷键。左键连发只更新预览，松开提交最终位置；右键短按 Seek、长按临时倍速，松开恢复。Escape、打开面板或窗口失焦取消待提交操作。

## 验证证据

- `node node_modules/typescript/bin/tsc --noEmit`：通过。
- `node node_modules/vite/bin/vite.js build --config vite.local.config.ts --configLoader runner`：通过；只有现有大 chunk 提示。runner 避免共享依赖目录下写入 Vite 临时配置。
- `node tests/player-controls/run.mjs`：Edge headless 真实 DOM、真实键盘/指针、真实定时器，7 组检查通过，无 pageerror。只替换 PlaybackCore，所有 API 在本地测试服务器返回空测试数据，不连接 8096。
- 覆盖面板内 select 的 Escape/焦点恢复；输入框、textarea、select、空 contenteditable 屏蔽快捷键；按钮 Space 原生激活；Space/M/F repeat；左键三次按下只提交 35 秒；右键短按至 40 秒和长按恢复原倍速；页面全屏两次 Escape 层级；指针焦点闲置 2.8 秒隐藏及 Tab 后 2.8 秒仍可见；320/360/390/412 px 单个下一集入口；重复 ended 与点击组合只回调一次。
- `node tests/player-controls/run.mjs --baseline`：从 Git HEAD 读取原版 Player.tsx（不修改工作文件），第一项 Escape 断言失败，面板数量实际 1、期望 0。确认测试能检出原始缺陷。
- `git diff --check`：通过。

测试需要可用 Edge 与 Playwright。若 Playwright 不在本项目，设置 `PLAYWRIGHT_MODULE` 为已安装包的 `index.mjs` 绝对路径。当前机器使用 `C:/Users/dytdy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs`。

## 隔离预览

`node tests/player-controls/run.mjs --serve` 提供 `http://127.0.0.1:5185/tests/player-controls/`（端口占用时以输出为准）。这是控件测试页，使用测试播放状态，没有真实视频。主服务 `http://127.0.0.1:8096/` 未更新，未重启、覆盖或修改数据。

## 最小合并方案与未完成验收

1. 只合并本工作树 `src/player/Player.tsx` 的增量、`tests/player-controls/` 四个文件以及 `.gitignore` 测试缓存规则。不拷贝整个 Player.tsx、core.ts、dist 或 node_modules。本次没有改 player.css 或后端。
2. 保留问题 04 的 audioTrackLabel import 和音轨 select 改动；保留主目录未提交品牌和后端修复。
3. 与问题 06 合并时，settingsPanel 改为 HTMLDialogElement 并复用该 ref；dialog 的 cancel 应 preventDefault 并调用 closePanel。保留原 panelOpener 焦点恢复及输入方式检测，关闭原生 dialog 后再恢复焦点。06 的 showModal/show effect 与本任务聚焦 effect 应合为一个有明确先后顺序的 effect。重复下一集条件由本任务负责。必须重新运行此测试。
4. 冷 Seek 的真实网络末值合并、管线生命周期依赖问题 03/07 的 core 修复；本测试不证明这些已合入或通过。
5. 原生浏览器全屏的系统 Escape 行为由浏览器控制，不能仅凭 preventDefault 保证拦截；本轮验证的是页面全屏 fallback。原生全屏下“面板优先”、真实手机触控、真实播放自动续集、合并后的移动抽屉仍待验收。
6. 按最新任务指令，本轮只在工作树验证，主服务有活跃播放，不同步主目录。共享问题文档应由整合任务将问题 05 状态改为“代码已修复，隔离回归通过；待整合与实播验收”，不要标为全部已解决。本记录可作为复测附件；总览仅修改播放控制对应行。

## main 整合复测

按用户要求准备推送 main。已在 main 的 17e7f4e 基础上整合，保留音轨、字幕和播放后端修复；解决设置面板相邻行冲突。整合后 TypeScript、生产构建及 7 组 Edge 控件测试再次通过。测试替身复用真实 audioTrackLabel 导出；--baseline 固定读取原始 beaf824 版本。主服务仍未部署，前述实播验收限制仍适用。
