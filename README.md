# dsh-agnes

基于 [Cordis](https://github.com/deepseek-ai/cordis) 的 DSH 插件，为 DSH 会话提供 Agnes AI 的图像与视频生成工具。

## 功能

- **图像生成**：`agnes_image_generate` 工具，通过 Agnes Image 2.1 Flash API 实现文生图、图生图（参考图）和多图合成。
- **视频生成**：`agnes_video_generate` 工具，通过 Agnes Video V2.0 API 实现文生视频、图生视频和关键帧动画（异步任务 + 轮询查询）。
- **设置面板**：通过 `dsh-settings` 提供配置界面，修改默认尺寸/宽高比无需重启即可生效。

## 安装

```bash
pnpm add dsh-agnes
```

需要以下 peer 依赖（DSH 环境已内置）：

- `@deepseek-ai/cordis`
- `@deepseek-ai/dsh-credentials`
- `@deepseek-ai/dsh-llm`
- `@deepseek-ai/dsh-settings`
- `@deepseek-ai/dsh-shell`
- `@deepseek-ai/dsh-tools`

## 配置

### 凭据

在 DSH 凭据中配置 `AGNES_API_KEY`，用于调用 Agnes API。密钥通过进程环境传递给 curl，不会出现在命令行中。

### 插件配置

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `defaultSize` | `1K` | 调用省略 `size` 时的默认尺寸档位 |
| `defaultRatio` | `1:1` | 调用省略 `ratio` 时的默认宽高比 |

## 工具说明

### agnes_image_generate

- **尺寸档位**：`1K`、`2K`、`3K`、`4K`
- **宽高比**：`1:1`、`3:4`、`4:3`、`16:9`、`9:16`、`2:3`、`3:2`、`21:9`
- **参数**：`prompt`（必填）、`size`、`ratio`、`image`（参考图 URL 数组）、`return_base64`

### agnes_video_generate

- **模型**：Agnes Video V2.0
- **模式**：文生视频（`prompt`）、图生视频（`image`）、关键帧动画（`keyframes`，至少两张）
- **主要参数**：`prompt`、`image`、`keyframes`、`width`（默认 1152）、`height`（默认 768）、`num_frames`（≤441 且遵循 8n+1 规则）、`frame_rate`（1–60）、`seed`、`negative_prompt`、`num_inference_steps`
- 视频生成是异步任务，工具会创建任务后以 5 秒间隔轮询直到完成或失败。

## 开发

```bash
pnpm install
```

本地开发时通过 `cordis.patch.yml` 将 `dsh-agnes-image` 映射到本仓库源码。