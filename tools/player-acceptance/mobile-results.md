# 问题 06：移动端布局修复与隔离验收

2026-09-14。状态：已基于 main 434a8fd 整合，Chrome 六档回归、Escape 关闭与焦点恢复、TypeScript 和生产构建通过；待运行服务部署与真机验收。

工作树：`C:\Users\dytdy\.codex\worktrees\4342\LMD本地视频共享`。

## 修复范围

- `src/player/player.css`：移动端时间独占一行，设置入口隐藏重复倍速数值，按钮不压缩；锁定入口移到标题行，避免与进度条重叠；安全区留白。
- `src/player/Player.tsx`：设置容器使用原生 dialog，移动端 showModal 进入浏览器顶层，桌面 show 保留非模态面板。移动抽屉固定底部，可滚动、关闭，不再增加舞台 min-height。触控帮助使用 coarse pointer 或 maxTouchPoints，保留 iOS 音量按键限制说明。
- `tools/player-acceptance/mobile-check.mjs`、`mobile-fixture.tsx`：真实 React 播放器与 PlaybackCore、本地验收 MP4、隔离模拟会话接口。全部测试请求留在隔离服务，不连接主服务。

## 证据

TypeScript `tsc -b`、Vite 生产构建、`git diff --check` 通过。构建保留已有大 bundle 警告。

| 视口 | 开关设置时舞台高度 | 结果 |
|---|---:|---|
| 320×568 | 166.5 px | 通过 |
| 360×800 | 189 px | 通过 |
| 390×844 | 205.875 px | 通过 |
| 412×915 | 218.25 px | 通过 |
| 844×390 | 461.25 px | 通过；非全屏视频按原比例可高于视口，抽屉在视口内 |
| 1440×900 | 650.25 px | 通过；桌面保留非模态面板及键盘帮助 |

各档检查：页面无横向溢出，控制按钮完整、互不重叠，锁定入口不遮进度条；设置面板在视口内，无横向溢出，滚动后关闭入口可命中；开关设置时暂停位置仍为 12 秒，播放状态下时间继续推进；坐标点击设置、字幕、锁定/解锁、全屏及退出成功；触控环境显示手势帮助。桌面分支明确模拟 maxTouchPoints=0，防止 CDP 前一轮触控状态残留。

回归反证：`--baseline-css` 只读加载 Git HEAD 旧 CSS，不改动源码；320px 下全屏按钮 right=314.859375，而舞台 right=308，测试检出 clipped=true、overlap=true 并失败。修复 CSS 同一测试通过。

运行：`node tools/player-acceptance/mobile-check.mjs <本地验收MP4>`。增加 `--serve` 保留隔离预览，地址 `http://127.0.0.1:8266/mobile-fixture`。截图及 JSON 位于本工作树 `data/mobile-acceptance/`，该目录不提交。端口 8266（预览）、9366（隔离浏览器）。

## 整合和验收边界

主服务 8096 没有被修改、覆盖或重启。本次 main 整合保留已合入的音轨、字幕、会话、控制及接口修复；此处通过范围仅为移动端矩阵及新增 Escape/焦点检查。

整合使用独立 `.push-main` 工作树，保留 main 已有修改。settingsPanel ref 已统一为 HTMLDialogElement，onCancel 使用 closePanel，关闭时先退出 dialog 模态再恢复 opener 焦点，保留问题 05 的 Escape capture 与下一集防重复逻辑。测试使用 LMD_MOBILE_PORT=8268、LMD_CDP_PORT=9368 避免占用原隔离预览；默认端口仍为 8266/9366。部署时只更新确认后的构建产物，保留运行数据、媒体及配置。
