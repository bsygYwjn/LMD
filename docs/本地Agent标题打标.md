# 本地 Agent 标题打标

在服务器电脑手动启动能执行命令并自行联网的 Agent。LMD 不调用 AI API，不保存 AI 密钥，不使用 Tavily 等搜索服务，也不会启动 Agent。扫描只刷新待处理清单。

## 使用

最简单的方式：

1. 打开本机管理端的 **视频标题打标**。
2. 选择需要处理的文件夹，例如 **アニメ**。默认包含所有子文件夹。
3. 点击 **复制打标任务**，发给服务器电脑上使用的 Agent。

Agent 会逐批核实、保存，再继续下一批，直到该范围处理结束。中断后再复制同一文件夹的任务即可继续；已有标题会跳过。页面显示的是所选范围的进度，不会因一个作品完成就把整个文件夹显示为完成。

任务文本会自动带上本机 Node 与 CLI 的绝对路径，在项目之外的新对话里也可以直接使用。命令参数、批量选择、待确认重试、来源及手动标题编辑放在 **高级选项与手动修改** 中；正常使用无需展开。

### 命令行（高级使用）

先启动 LMD，在项目或发布包目录执行（没有系统 Node 时，将 `node` 换为 `runtime\node.exe`）：

```powershell
node tools/lmd-label.mjs status
node tools/lmd-label.mjs prompt
node tools/lmd-label.mjs claim --limit 10
node tools/lmd-label.mjs validate --file result.json
node tools/lmd-label.mjs apply --file result.json
node tools/lmd-label.mjs release --batch 批次ID
```

默认端口 8096，或 LMD_PORT / LANTERN_PORT 环境变量。显式指定 `--port 8097` 可以连接其他本机实例。服务未启动会报连接错误。

管理端“视频目录 → 标题 / 本地 Agent 打标”可复制提示词和范围命令。选择单视频、文件夹或多项：

```powershell
node tools/lmd-label.mjs claim --id 目标ID --scope direct
node tools/lmd-label.mjs claim --ids 目录ID1,目录ID2 --scope children
node tools/lmd-label.mjs claim --id 目录ID --scope recursive
node tools/lmd-label.mjs claim --id 目录ID --retry
```

`direct` 对所选文件夹及其所有视频作为一组领取，也支持没有直属视频的中间目录。不要对包含多部不同作品的大目录使用 direct；此时选 children 或 recursive。`children` 将直属子文件夹逐组领取，`recursive` 在指定范围寻找作品组。标准 Season 1 / S01 / 第1季目录按父作品合并；无法确定是否同一作品时 Agent 应标待确认。

Agent 获得 ID、版本、目录名、代表文件名及已有季集线索，无绝对路径。每批最多 10 组，期限 30 分钟。结果按 `slot` 指定既有视频，服务端展开集名；不得返回季数、集数、路径等修改。一次提交的所有作品名和集名一起检查、一起持久化。

把 `prompt` 输出及管理端生成的范围命令交给 Agent 即可。Agent 自行联网查证，验证后直接提交，继续处理当前范围直到没有任务，然后退出。无需逐项导入。搜索失败应释放批次并退出，保留待处理；有歧义返回 `review` 和原因，仅在用户显式选择 `--retry` 后重新纳入。

## 保护与核实边界

- 已有作品标题的文件夹及其继承视频整组跳过，不补空缺集名，后续新增集数也跳过。单视频标题优先于文件夹标题。
- 手动编辑优先。领取及提交均检查版本、对象存在性和已有标题；旧批次不能覆盖后来的手动修改。清除此范围打标会清除其后代显示记录；仍继承上级标题时，应在已打标的上级目录清除。
- 只改网页显示。磁盘文件名、媒体内容、季度、集数、分类与字幕不变。旧手动接口仍可设置季度，新 Agent 接口拒绝这些字段。
- 独立记录在运行数据目录 `display-labels.json`，扫描不会写入该文件。批次与提交摘要在同一原子替换中保存；同一批次同一结果可幂等重试。过期或释放后的未完成任务可重新领取。备份数据时应包含此文件和原有 state.json。
- 首映原名指首次发行/上映时的正式名称。中文单集名必须已经公开发布；没有中文单集名就使用正式原文，不允许 Agent 自行翻译。
- 后台注明“Agent 提供来源”。服务端只校验来源格式、简短证据、范围和保护规则，不自行访问或独立验证网页内容；来源真实性与作品映射依赖 Agent 查证。官网、发行方、播出平台优先，TMDB / TVmaze 辅助。
- 观看者可切换“中文常见名称 / 首映原名”，偏好保存在当前浏览器。缺少语言时回退已有名称，搜索匹配双语名称与原文件名，不触发 Agent。

## 验证

```powershell
node server/labels.test.mjs
node server/labels-integration.test.mjs
node src/title-language.test.ts
```

使用固定模拟 Agent 结果；不依赖任何 AI 服务或真实搜索。测试目录独立，不修改运行媒体。

## 待审核候选（本次未实现）

自然语言搜索、音乐/电子书标题识别、媒体库整理建议。
