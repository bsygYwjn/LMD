# 问题 08：测试补充与验收记录

状态：已补独立测试入口；尚未完成全部验收，不能标为已解决。

工作树：`C:\Users\dytdy\.codex\worktrees\5636\LMD本地视频共享`。
本任务只新增测试和证据，不重启、不覆盖主目录。最初验收时工作树为旧业务基线，使用 `LMD_TEST_PROJECT` 指向包含问题 02 修复的目录运行解析测试；下表保留当时的目标与结果。

推送前已基于远程 main 的 `3af557f` 建立 `codex/issue08-main`，保留已合入的其他任务修复。在当前工作树重跑 `box-boundaries.mjs`、`box-budget.mjs` 均通过，10 路 128 MiB 采样峰值 RSS 90.18 MiB、增量 50.07 MiB；五个新增脚本语法检查通过。未将历史 8096 浏览器失败记录改写为新 main 已通过，生产浏览器与真机仍需复测。

## 已执行与证据

| 项目 | 实际结果 | 范围及限制 |
|---|---|---|
| `box-budget.mjs` | 通过，64/128 MiB 单路约 31.9/62.9 ms；5 路 64 MiB 151.5 ms；10 路 128 MiB 601.2 ms，采样峰值 RSS 99.15 MiB，增量 47.37 MiB | 主目录问题 02 的解析器；每种配置独立进程、每次输入新 Buffer；硬上限 RSS 384 MiB、增量 192 MiB。不是 FFmpeg/落盘全管线压测；采样可能遗漏瞬时峰值 |
| `box-boundaries.mjs` | 通过 | 逐字节扩展头、零/过小/超大/非安全整数长度、头与 payload 截断、上游中断传播；不冒充半成品发布测试 |
| 主目录 `server/playback-integration.test.mjs` | 通过 | 真 FFmpeg、动态滑动清单禁 VOD、TARGETDURATION 固定、EOF ENDLIST、Range、解码验证、释放后 sessions/pipelines 均为 0；不等于原生 HLS/hls.js 播完 |
| 5618 的 `server/playback-boundaries.test.mjs` | 通过 | 真 HTTP + 注入 probe/媒体依赖；405/Allow/HEAD，错误方法不 probe、不创建缓存/会话，stale generation 不改 position |
| 5618 的 `server/player-recovery.test.mjs` | 通过 | 模拟 video/fetch 的 core 回归，覆盖并发 retry 合并、失败管线 PATCH、媒体切换及过时错误隔离；不证明可听音频无叠音 |
| `mobile-matrix.mjs` | 已执行，5 个尺寸均检出旧服务布局问题 | 真实 Chromium + 响应式模拟，8096；320 全屏裁切，320/360/390/412 设置使舞台增高到 330 px，844×390 面板超出视口。详见 `issue-08-evidence/mobile-before.json` 与 10 张截图；320 截图已人工查看 |
| `ass-csp.mjs` | 已执行，生产 CSP 前置失败，0 个字幕用例通过 | 8096 尚未允许要求的 WASM 权限；未到达 JASSUB/降级阶段。失败报告 `issue-08-evidence/ass-before.json` |
| `pgs-reference.mjs` | 语法检查通过；真实像素用例未执行 | 缺独立批准的真实 PGS 参考图及 manifest；缺参数退出码 2，绝不静默记为通过 |

上述主目录指 `C:\Users\dytdy\Desktop\LMD本地视频共享`；5618 指 `C:\Users\dytdy\.codex\worktrees\5618\LMD本地视频共享`。所有隔离集成测试只处理自己创建的临时数据。未运行本树全量构建，因为没有业务代码/依赖变更且本树未安装依赖。新增脚本逐一进行了 Node 语法检查。

## 重跑命令

```powershell
$env:LMD_TEST_PROJECT='C:\Users\dytdy\Desktop\LMD本地视频共享'
node tools/player-acceptance/box-budget.mjs
node tools/player-acceptance/box-boundaries.mjs

# 指向合并修复后的隔离生产实例；脚本不会启动或修改服务。
$env:LMD_BASE_URL='http://127.0.0.1:测试端口'
$env:LMD_CDP_PORT='19438'
node tools/player-acceptance/mobile-matrix.mjs

# 将带 ASS 样例置于根目录卡片列表；此脚本要求可见的精确标题。
$env:LMD_ASS_MEDIA='实际卡片标题'
$env:LMD_CDP_PORT='19439'
node tools/player-acceptance/ass-csp.mjs

node tools/player-acceptance/pgs-reference.mjs C:\测试资料\pgs-reference.json
```

浏览器脚本复用现有 `cdp.mjs`，本机需安装该 helper 支持的 Chrome。每次生成独立临时 profile、JSON、截图；结束导航到 about:blank 并关闭自建浏览器。脚本尚未独立断言关闭后的所有请求/FFmpeg 释放，不能由此宣称关闭生命周期全验收。不要同时复用同一调试端口。

## ASS 生产验收

修复合并并构建后重跑。脚本正常组保留服务原始 CSP，不开启 bypassCSP；负向组仅通过浏览器响应拦截删除文档头中的 wasm-unsafe-eval，不修改服务配置、不伪造字幕渲染器。正常组检查 styled 模式及 JASSUB canvas；负向组要求自动 text 模式且非空字幕。

**canvas 存在不证明字体/定位/动画正确。** 必须查看 2、7、12、16、32 秒截图，分别确认底部白字描边、顶部青色、黄色左右移动、绿色字幕；记录浏览器版本、生产构建哈希、原始 CSP、控制台/WASM 错误及人工签名。当前正负两组都未验收，截图烟雾测试入口不能替代 worker ready、像素和运动判断。

## 真实 PGS 参考 manifest

参考图必须由独立解码器或人工批准生成，不能从当前 LMD 输出反向制作。示例中的路径、哈希、轨道、坐标与时刻都必须替换为真实资料：

```json
{
  "base": "http://127.0.0.1:测试端口",
  "mediaId": "真实媒体ID", "track": 2, "codec": "hdmv_pgs_subtitle",
  "start": 300, "duration": 35, "maxWindowMs": 15000,
  "ffmpeg": "C:/工具/ffmpeg.exe",
  "referenceProvenance": "独立解码器版本、源媒体哈希、批准人及日期",
  "expected": [{ "start": 305, "x": 120, "y": 800, "width": 600, "height": 80,
    "png": "approved-cue.png", "sha256": "参考PNG的SHA256" }]
}
```

脚本验证服务 info 真 PGS 轨道、真实 endpoint 图像、真实 FFmpeg RGBA 解码、参考图哈希、颜色/透明度、裁剪尺寸与 x/y；最大单通道差 3，平均误差 0.5。真实样本缺失时保持未验收。单次耗时受缓存影响，不能据此证明首次冷窗口性能；首开与中段冷请求必须另用临时数据目录，记录 FFmpeg 实际 -ss/-t、处理帧数及缓存状态。旧请求 Abort 后需核对对应 PID 退出，替换源样本需在临时库中验证旧签名 URL 不可读取。现有问题 01 注入 RGBA 测试可验证逻辑，不能替代这些真实 PGS 验收。

## 仍需验收

- 合并问题 01/06/07 后的生产 CSP/ASS 正向与禁 WASM 降级、四档布局通过截图。
- 真实 PGS 独立参考像素、冷窗口开销、取消、源版本 URL 隔离。
- 原生 Safari HLS 与 hls.js 完播、Seek、EOF 后稳定清单。
- 5～10 路真实 FFmpeg + 64～128 MiB 长 GOP mdat，记录全进程树 RSS；中断时轮询分片 HTTP 与临时目录，半成品绝不能返回 200。
- 连续 Seek 最终位置、音轨切换/重试可听验证无叠音、关闭页面后本次会话/PID/网络请求全部释放。
- 真 Android/iOS 竖屏/横屏/全屏/安全区，多指、长按、横滑 Seek、左右竖滑、系统边缘返回冲突。记录设备型号、系统/浏览器版本和录像。浏览器模拟不能填为真机通过。

## 最小合并方案

只加入 `tools/player-acceptance/{box-budget,box-boundaries,mobile-matrix,ass-csp,pgs-reference}.mjs`、本文、`docs/issue-08-evidence/`。不复制本树旧的 server/src/package.json/dist，不覆盖其他任务的集成测试。

先由对应任务合并业务修复，再按上述命令复测。共享 `08-测试覆盖与验收缺口.md` 的建议状态为“独立测试已补，真实字幕/客户端/真机仍待验收”；总览仅替换测试覆盖对应行，禁止把问题 08 标为全通过。遵循本轮工作树范围约束，未改共享问题目录，本文作为待合并记录。
