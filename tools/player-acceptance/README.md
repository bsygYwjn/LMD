# 播放核心验收工具

这两个脚本用 Chrome DevTools Protocol 驱动**真实浏览器和真实界面**，验证统一播放核心与管理设置页。它们只在开发机上使用，不参与服务运行。

## 前置条件

1. 服务已在本机启动（默认 `http://127.0.0.1:8096`）。
2. 目录里至少有一个可播放视频（脚本会自行扫描目录）。
3. 需要真实播放验收时，用 `LMD_PLAYER_TEST=1` 启动服务。
4. 本机安装了 Chrome 或 Edge。

## 使用

```powershell
# 服务端（另开一个窗口）
$env:LMD_PLAYER_TEST='1'; node server/index.mjs

# 播放核心验收：目录 → 详情 → 播放页 → 控制条 → 移动视口
node tools/player-acceptance/browser-check.mjs

# 管理设置页验收：播放缓存卡片、依赖 play 凭证卡片与后端契约
node tools/player-acceptance/settings-check.mjs
```

可用 `LMD_BASE_URL` 指向其他地址。脚本会在同目录生成 `chrome-profile/`、`shots/`（截图与 `report.json`），可以随时删除。

## browser-check 覆盖内容

- 目录浏览、进入播放页、创建 video 元素、自定义控制条与缓冲条
- 实际出画、`requestVideoFrameCallback` 真实渲染帧、首帧耗时
- 媒体时长从已生成分片收敛到原片精确长度
- 单击暂停/恢复、进度条缓冲内定位、冷 Seek、连续快速 Seek 收敛
- 倍速切换、切换音轨后在新会话继续播放
- 全屏进入与退出
- 离开播放页后本次创建的全部会话逐个确认已释放
- 移动视口（412×915 + 触摸）出画、滑动预览与提交 Seek、双击切换、防误触锁定
- 播放接口无 5xx、页面无未捕获错误

## settings-check 覆盖内容

- 读取/保存/恢复播放设置，拒绝非法租约与越界参数
- 弹幕凭证保存与清除，读取接口不回传密钥
- 运行设置页渲染播放卡片（7 个字段）与弹幕卡片（2 个字段）
- 不再出现过时的“自动生成完整兼容副本”描述

## 说明

服务端另有一个不依赖外部脚本的自检入口：用 `LMD_PLAYER_TEST=1` 启动后打开 `http://127.0.0.1:8096/?playerTest=1`，页面会自动跑同一批检查并把结果写入 `data/playback-test/browser-report.json`。它适合在无法使用脚本的机器（例如临时借用的浏览器）上做验收。

未完成的验收项（弹弹play 有效凭证联调、真实位图字幕样片、ASS 全特效样片、Android/Safari/真机、长 GOP 与高码率压力）见 `docs/播放核心测试报告.md`。
