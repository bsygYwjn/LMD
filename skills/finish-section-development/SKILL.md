---
name: finish-section-development
description: Finish an LMD feature branch when the user says “结束此分区开发” or explicitly asks to merge the current branch, publish it to GitHub, and produce a verified Windows release package.
---

# 结束分区开发

把当前 LMD 功能分支作为一个可追溯的发布周期正式收尾。这个触发语授权为当前项目提交代码、合并到 `main`、推送 GitHub、创建版本标签与 GitHub Release；它不授权覆盖已有标签、Release、发布目录或真实运行数据。

## 版本

- 优先使用用户本次明确指定的版本，标签格式为 `V<major>.<minor>_Beta`，发布目录与压缩包名为 `LMD_<tag>`。
- 若用户只说“结束此分区开发”，从现有最高 `V<major>.<minor>_Beta` 标签递增 minor 版本；若标签不连续或存在同名目标，停止并说明冲突。
- 把 `package.json` 的版本同步为 `<major>.<minor>.0-beta`，并在提交前完成构建和测试。

## 收尾流程

1. 记录当前分支、工作树、远端、主分支差异、既有标签和 Release。保留用户的全部在途改动；发现无法判断归属的修改时不要擅自丢弃。
2. 检查 8096 实际运行实例、视频/音乐扫描和转换任务。任务静止后备份真实 `data/state.json`；发布包不得包含真实 `data/`、媒体、缓存、访问码或用户配置。
3. 更新版本和必要文档，执行生产构建、全量测试、健康接口及受影响页面检查。构建产物继续同步当前 8096 服务。
4. 在当前功能分支提交本周期变更。获取 `origin` 后，将本地 `main` 快进到 `origin/main`，再使用明确的非快进合并提交合入功能分支。解决冲突时同时保留远端更新和本分支功能。
5. 合并后再次运行生产构建和全量测试。任何检查失败都不得推送标签或创建 Release。
6. 运行 [scripts/build-release.ps1](scripts/build-release.ps1) 生成干净的 Windows 发布目录和 ZIP。脚本必须在目标已存在时失败，不得覆盖旧发布版。
7. 用发布目录自带的 `runtime/node.exe` 在临时端口启动一次，确认健康接口可用、状态版本正确且使用的是全新数据目录，然后停止测试进程。
8. 推送 `main`，创建并推送带说明的版本标签，再用同一标签创建 GitHub prerelease，上传 ZIP 并附上 SHA-256、主要变化及验证结果。不要重用或强制移动既有标签。
9. 验证远端 `main`、标签、Release 资产、本地发布目录与 ZIP。保留已合并的本地功能分支，除非用户另外要求删除。

## 发布包边界

发布包包含运行所需的 `assets`、`dist`、生产依赖、`runtime`、`server`、`tools`、托盘脚本、启动脚本和使用说明；生产依赖必须按已提交的锁文件从 pnpm store/registry 重新部署，不能直接复制含绝对 junction 的开发 `node_modules`。只创建空的 `data/cache` 结构，源码、Git 元数据、开发 skill、测试缓存和真实状态不进入发布包。

默认发布根目录是 `C:\Users\dytdy\Desktop\LMD发布版`。打包脚本返回目录、ZIP、SHA-256 和文件大小，后续 GitHub Release 必须使用这份已验证的 ZIP。
