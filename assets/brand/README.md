# LMD 标识

两条线，一个向外开放的本地媒体库。L 形底座与右向折线组成固定轮廓，图形本身即可作为单色线稿。

## 资源

| 文件 | 用途 |
| --- | --- |
| `lmd-mark.svg` | 唯一可编辑的矢量母版，透明底、品牌蓝 |
| `lmd-icon.svg` / `lmd-icon.png` | 纯蓝圆角底、白色标志，网页 / 文档 / App |
| `lmd-mono.svg` | 深色单色标志，浅背景使用 |
| `lmd-inverse.svg` | 白色反白标志，深背景使用 |
| `lmd-mark.png` | 透明底 512px 品牌蓝标志 |
| `lmd.ico` | Windows 图标，包含 16 / 20 / 24 / 32 / 40 / 48 / 64 / 128 / 256px |

## 使用规则

- 品牌蓝 `#3267E3`，深色单色 `#172033`，反白 `#FFFFFF`。
- 两条笔画使用 7 单位等宽圆角线，画布为 64 × 64；不要单独旋转、拉伸或改变笔画比例。
- 独立标志四周至少保留一条笔画宽度的空白，App 图标已包含内部留白。
- 界面推荐 28–32px，浏览器和托盘最小 16px。小尺寸使用提供的 ICO 帧或 SVG，不从大图截图缩小。
- 不增加渐变、阴影、立体、发光或额外装饰；在复杂背景上使用纯色 App 图标。
- 图形与 `LMD` 文字并排时保留约 8px 间隔。图形作为按钮时提供有意义的无障碍名称。

## 重新生成

在项目根目录执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/build-tray-icons.ps1
pnpm build
```

脚本只读取 `assets/brand/lmd-mark.svg` 的几何，生成本目录的衍生文件、`assets/tray-*` 和 `public/brand/*`、`public/favicon.ico`。母版支持绝对坐标的 `M`、`L`、`Q` 命令；改变图形后应重新检查所有小尺寸。

`assets/icon-source/` 中的旧托盘选稿为历史素材，不再参与构建。托盘运行 / 停止状态沿用同一轮廓，以蓝底 / 灰底及文字状态区分。
