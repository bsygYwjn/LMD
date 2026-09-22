# 问题 07 集成验证

基线：origin/main 3af557f，保留现有字幕、HLS、音轨、播放控制和会话复用修复。

本次修复：按播放路由限制 HTTP 方法并返回 Allow，info 支持 GET/HEAD 且错误方法不触发探测或创建；探测异常返回 PROBE_FAILED；更新位置/租约前验证 generation；首次探测失败可重新尝试，同步重试请求合并，失败管线复用 sessionId 经 PATCH seek 恢复，代次冲突先读取服务端状态，切换媒体清除旧元数据及迟到错误。

验证通过：

- server/playback-boundaries.test.mjs
- server/player-recovery.test.mjs
- server/playback-corrupt-media.test.mjs
- server/playback-integration.test.mjs（5 会话/5 管线全部释放）
- src/player/latest-task-queue.test.ts、src/player/audio-switch.test.mjs
- TypeScript --noEmit、Vite 生产构建（--configLoader native）

新增 test:playback-recovery，并加入 test:all。测试使用隔离数据；未修改或重启主服务。S01E09 真实浏览器错误弹层、重试与关闭的人工视觉验收仍待完成。
