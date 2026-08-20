/**
 * `agnes_video_generate` 工具:通过 Agnes Video V2.0 API 实现文生视频、图生视频和关键帧动画。
 * 视频生成是异步任务:先创建任务,再轮询查询结果直到完成或失败。
 * 请求体写入 curl 标准输入,密钥通过进程环境传递,均不进入命令行。
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ShellExecutor } from '@deepseek-ai/dsh-shell'
// 仅用于类型:引入 shell 的 Context 合并。
import type {} from '@deepseek-ai/dsh-shell'

import { AGNES_API_KEY_REF, splitAgnesStatus } from './image.ts'

/** Agnes 视频 API 端点:创建任务。 */
export const AGNES_VIDEO_API_URL = 'https://api.agnes-ai.cn/v1/videos'

/** Agnes 视频 API 端点:按 video_id 查询结果(推荐)。 */
export const AGNES_VIDEO_QUERY_URL = 'https://api.agnes-ai.cn/agnesapi'

/** 视频生成模型。 */
export const AGNES_VIDEO_MODEL = 'agnes-video-v2.0'

/** 创建/查询单次请求的 curl 网络超时。 */
export const AGNES_VIDEO_CURL_TIMEOUT_S = 60

/** 轮询查询结果的时间间隔。 */
export const AGNES_VIDEO_POLL_INTERVAL_MS = 5_000

/** 工具调用的协作式超时预算;视频生成可能需要数分钟。 */
export const AGNES_VIDEO_TOOL_TIMEOUT_MS = 900_000

/** JSON 响应捕获上限。 */
export const AGNES_VIDEO_STDOUT_MAX_BYTES = 32 * 1024 * 1024

/** 工具参数:与 API 的请求字段一一对应。 */
export interface AgnesVideoArgs {
  /** 视频内容的文本描述。 */
  prompt: string
  /** 图生视频模式:单张公共 HTTPS 图片 URL。 */
  image?: string
  /** 关键帧动画模式:公共 HTTPS 图片 URL 数组,至少两张。 */
  keyframes?: string[]
  /** 视频宽度,默认 1152;不支持的精确尺寸由 API 标准化。 */
  width?: number
  /** 视频高度,默认 768;不支持的精确尺寸由 API 标准化。 */
  height?: number
  /** 视频帧数,必须 ≤ 441 且遵循 8n + 1 规则。 */
  num_frames?: number
  /** 视频帧率,支持 1–60。 */
  frame_rate?: number
  /** 随机种子,用于可复现结果。 */
  seed?: number
  /** 反向提示词,描述需要避免的内容。 */
  negative_prompt?: string
  /** 推理步数。 */
  num_inference_steps?: number
}

/** 创建任务响应中的关键字段。 */
export interface AgnesVideoTask {
  /** 任务 ID。 */
  id?: string
  /** 任务 ID,作用与 `id` 相同。 */
  task_id?: string
  /** 视频 ID,推荐用于查询结果。 */
  video_id?: string
  /** 当前任务状态。 */
  status?: string
}

/** 工具规范化结果值,只含 API 实际返回的字段。 */
export interface AgnesVideoValue {
  /** 视频 ID。 */
  video_id?: string
  /** 任务 ID,作用与 `id` 相同。 */
  task_id?: string
  /** 任务状态:queued / in_progress / completed / failed。 */
  status?: string
  /** 任务进度百分比。 */
  progress?: number
  /** 视频时长,单位为秒。 */
  seconds?: string
  /** 标准化后的实际输出视频分辨率。 */
  size?: string
  /** 最终生成的视频 URL,仅 completed 时可用。 */
  url?: string
  /** 尺寸标准化信息。 */
  size_mapping?: JsonValue
  /** 任务失败时的错误信息。 */
  error?: JsonValue
}

/** 参考图片必须是可以被 API 直接抓取的公共 URL。 */
const VIDEO_IMAGE_PATTERN = /^https?:\/\//

/**
 * 根据参数构建创建任务的 API 请求体。
 * @throws 参数不合法时抛出面向模型的错误。
 */
export function buildAgnesVideoRequestBody(args: AgnesVideoArgs): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: AGNES_VIDEO_MODEL,
    prompt: args.prompt,
  }
  if (args.width !== undefined) {
    if (!Number.isInteger(args.width) || args.width <= 0) {
      throw new Error(`无效的 width ${args.width}:必须是正整数。`)
    }
    body.width = args.width
  }
  if (args.height !== undefined) {
    if (!Number.isInteger(args.height) || args.height <= 0) {
      throw new Error(`无效的 height ${args.height}:必须是正整数。`)
    }
    body.height = args.height
  }
  if (args.num_frames !== undefined) {
    if (!Number.isInteger(args.num_frames) || args.num_frames < 1 || args.num_frames > 441 || args.num_frames % 8 !== 1) {
      throw new Error(`无效的 num_frames ${args.num_frames}:必须 ≤ 441 且满足 8n+1(如 81/121/241/441)。`)
    }
    body.num_frames = args.num_frames
  }
  if (args.frame_rate !== undefined) {
    if (args.frame_rate < 1 || args.frame_rate > 60) {
      throw new Error(`无效的 frame_rate ${args.frame_rate}:支持范围为 1–60。`)
    }
    body.frame_rate = args.frame_rate
  }
  if (args.seed !== undefined) body.seed = args.seed
  if (typeof args.negative_prompt === 'string' && args.negative_prompt !== '') body.negative_prompt = args.negative_prompt
  if (args.num_inference_steps !== undefined) {
    if (!Number.isInteger(args.num_inference_steps) || args.num_inference_steps <= 0) {
      throw new Error(`无效的 num_inference_steps ${args.num_inference_steps}:必须是正整数。`)
    }
    body.num_inference_steps = args.num_inference_steps
  }
  const keyframes = Array.isArray(args.keyframes)
    ? args.keyframes.filter((item): item is string => typeof item === 'string')
    : []
  const image = typeof args.image === 'string' && args.image !== '' ? args.image : undefined
  if (keyframes.length > 0) {
    if (image !== undefined) {
      throw new Error('image 与 keyframes 不能同时使用:图生视频传单张 image,关键帧动画传 keyframes 数组。')
    }
    for (const url of keyframes) {
      if (!VIDEO_IMAGE_PATTERN.test(url)) {
        throw new Error(`无效的关键帧图片 "${url.slice(0, 64)}":必须是公共 HTTPS 图片 URL。`)
      }
    }
    body.extra_body = { image: keyframes, mode: 'keyframes' }
  } else if (image !== undefined) {
    if (!VIDEO_IMAGE_PATTERN.test(image)) {
      throw new Error(`无效的 image "${image.slice(0, 64)}":必须是公共 HTTPS 图片 URL。`)
    }
    body.image = image
  }
  return body
}

/**
 * 解析创建任务响应。
 * @throws 响应体形状不符时抛出面向模型的错误。
 */
export function parseAgnesVideoTask(jsonText: string): AgnesVideoTask {
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText) as unknown
  } catch (_jsonParseFailure) {
    throw new Error(`Agnes API 返回了无法解析的内容:${jsonText.slice(0, 500)}`)
  }
  const record = parsed as Record<string, unknown> | null
  if (record === null || typeof record !== 'object') {
    throw new Error(`Agnes API 未返回有效的任务信息:${jsonText.slice(0, 500)}`)
  }
  const value: AgnesVideoTask = {}
  if (typeof record.id === 'string') value.id = record.id
  if (typeof record.task_id === 'string') value.task_id = record.task_id
  if (typeof record.video_id === 'string') value.video_id = record.video_id
  if (typeof record.status === 'string') value.status = record.status
  return value
}

/**
 * 解析查询结果响应。
 * @throws 响应体形状不符时抛出面向模型的错误。
 */
export function parseAgnesVideoQuery(jsonText: string): AgnesVideoValue {
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText) as unknown
  } catch (_jsonParseFailure) {
    throw new Error(`Agnes API 返回了无法解析的内容:${jsonText.slice(0, 500)}`)
  }
  const record = parsed as Record<string, unknown> | null
  if (record === null || typeof record !== 'object') {
    throw new Error(`Agnes API 未返回有效的视频信息:${jsonText.slice(0, 500)}`)
  }
  const value: AgnesVideoValue = {}
  if (typeof record.video_id === 'string') value.video_id = record.video_id
  if (typeof record.task_id === 'string') value.task_id = record.task_id
  if (typeof record.status === 'string') value.status = record.status
  if (typeof record.progress === 'number') value.progress = record.progress
  if (typeof record.seconds === 'string') value.seconds = record.seconds
  if (typeof record.size === 'string') value.size = record.size
  // 实际响应把 url / size_mapping 放在顶层;文档示例为 metadata.url,两层都兼容。
  if (typeof record.url === 'string' && record.url !== '') value.url = record.url
  if (record.size_mapping !== null && typeof record.size_mapping === 'object') {
    value.size_mapping = record.size_mapping as JsonValue
  }
  const metadata = record.metadata
  if (metadata !== null && typeof metadata === 'object') {
    const meta = metadata as Record<string, unknown>
    if (value.url === undefined && typeof meta.url === 'string' && meta.url !== '') value.url = meta.url
    if (value.size_mapping === undefined && meta.size_mapping !== null && typeof meta.size_mapping === 'object') {
      value.size_mapping = meta.size_mapping as JsonValue
    }
  }
  if (record.error !== undefined) value.error = record.error as JsonValue
  return value
}

/**
 * 将规范化结果值渲染为面向模型的内容。
 */
export function renderAgnesVideoValue(args: AgnesVideoArgs, value: AgnesVideoValue): ContentBlock[] {
  const lines: string[] = []
  lines.push(`状态:${value.status ?? 'unknown'} | 进度:${value.progress ?? 0}%`)
  if (value.size !== undefined) lines.push(`分辨率:${value.size}`)
  if (value.seconds !== undefined) lines.push(`时长:${value.seconds} 秒`)
  if (value.url !== undefined) lines.push(`视频 URL:${value.url}`)
  if (value.size_mapping !== null && typeof value.size_mapping === 'object' && typeof value.size_mapping.message === 'string') {
    lines.push(`尺寸标准化:${value.size_mapping.message}`)
  }
  if (value.status === 'failed') {
    const err = value.error
    lines.push(`任务失败:${typeof err === 'string' ? err : JSON.stringify(err ?? '(无错误详情)')}`)
  }
  lines.push(`模型:${AGNES_VIDEO_MODEL} | video_id:${value.video_id ?? value.task_id ?? '未知'}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * 执行一次 curl 请求,拆分响应体与末尾状态码并做统一错误处理。
 * 密钥通过进程环境传递,不进入命令行;请求体可经 stdin 传入。
 */
async function runCurl(shell: ShellExecutor, apiKey: string, command: string, signal: AbortSignal, stdin?: string): Promise<string> {
  const spec = shell.resolve({
    command,
    stdin,
    env: { [AGNES_API_KEY_REF]: apiKey },
    stdoutMaxBytes: AGNES_VIDEO_STDOUT_MAX_BYTES,
    timeoutMs: AGNES_VIDEO_CURL_TIMEOUT_S * 1000,
    signal,
  })
  const result = await shell.run(spec)
  if (result.timedOut || result.aborted) {
    throw new Error(`视频 API 请求${result.timedOut ? '超时' : '被取消'}(${result.timeoutMs}ms),请稍后重试。`)
  }
  if (result.exitCode !== 0) {
    throw new Error(`Agnes API 请求失败(exit ${result.exitCode}):${result.stderr.text.slice(0, 500)}`)
  }
  if (result.stdout.truncated) {
    throw new Error('Agnes API 响应过大,超出捕获上限。')
  }
  const { jsonText, status } = splitAgnesStatus(result.stdout.text)
  if (status !== null && (status < 200 || status >= 300)) {
    throw new Error(`Agnes API 返回 HTTP ${status}:${jsonText.slice(0, 800)}`)
  }
  return jsonText
}

/** 等待指定时长,提前触发 abort 时立即返回。 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

/**
 * 按 video_id 轮询查询结果,直到任务完成或失败。
 * @throws 超过总预算或调用被取消时抛出面向模型的错误。
 */
async function pollAgnesVideo(shell: ShellExecutor, apiKey: string, videoId: string, signal: AbortSignal): Promise<AgnesVideoValue> {
  const deadline = Date.now() + AGNES_VIDEO_TOOL_TIMEOUT_MS
  const queryCommand = `curl -sS --max-time ${AGNES_VIDEO_CURL_TIMEOUT_S} -G ${AGNES_VIDEO_QUERY_URL} --data-urlencode "video_id=${videoId}" -H "Authorization: Bearer $AGNES_API_KEY" -w '\\n__AGNES_STATUS__%{http_code}'`
  let value: AgnesVideoValue
  for (;;) {
    if (signal.aborted) {
      throw new Error(`视频生成查询被取消(video_id=${videoId})。`)
    }
    value = parseAgnesVideoQuery(await runCurl(shell, apiKey, queryCommand, signal))
    if (value.status === 'completed' || value.status === 'failed') return value
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new Error(`视频生成超时(超过 ${AGNES_VIDEO_TOOL_TIMEOUT_MS}ms),任务仍处于 ${value.status ?? 'unknown'} 状态;可使用 video_id=${videoId} 稍后重新查询。`)
    }
    await sleep(Math.min(AGNES_VIDEO_POLL_INTERVAL_MS, remaining), signal)
  }
}

/**
 * 在上下文中注册 `agnes_video_generate` 工具。
 * 注册挂载在调用插件的 fiber 上,随其一同移除。
 */
export function applyAgnesVideoTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'agnes_video_generate',
    description: '调用 Agnes Video V2.0 API(模型 agnes-video-v2.0)生成视频,支持三种模式:文生视频(仅传 prompt)、图生视频(image 传单张公共 HTTPS 图片 URL)和关键帧动画(keyframes 传两张以上公共 HTTPS 图片 URL,在关键帧之间生成平滑过渡)。视频生成是异步任务,工具会先创建任务再轮询查询结果,完成后直接返回视频 URL(metadata.url);失败时返回 error 详情。时长由 num_frames 与 frame_rate 控制(seconds = num_frames / frame_rate);num_frames 必须 ≤ 441 且满足 8n+1(配合 frame_rate 24:81≈3 秒、121≈5 秒、241≈10 秒、441≈18 秒),frame_rate 支持 1–60。宽高默认 1152x768;提交的尺寸会被 API 标准化到 480p/720p/1080p 档位,以返回的 size 与 metadata.size_mapping 为准。提示词结构:文生视频 = 主体+动作+场景+镜头运动+光线+风格;图生视频 = 描述应运动与应保持稳定的元素;关键帧 = 描述关键帧之间的过渡关系。设置 seed 可复现结果,negative_prompt 可排除不需要的内容。',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: '视频内容的文本描述。文生视频:主体+动作+场景+镜头运动+光线+风格;图生视频:描述应运动的元素与应保持稳定的元素;关键帧动画:描述关键帧之间的过渡关系。',
      },
      image: {
        type: 'string',
        description: '图生视频模式的输入图片 URL(公共 HTTPS 图片),生成以该图片为第一帧的动态视频;与 keyframes 互斥。',
      },
      keyframes: {
        type: 'array',
        items: { type: 'string' },
        description: '关键帧动画模式的输入图片 URL 数组(公共 HTTPS 图片,至少两张),在关键帧之间生成平滑过渡;与 image 互斥。',
      },
      width: {
        type: 'integer',
        description: '视频宽度,默认 1152;不支持的精确尺寸会被 API 标准化到 480p/720p/1080p 档位。',
      },
      height: {
        type: 'integer',
        description: '视频高度,默认 768;不支持的精确尺寸会被 API 标准化到 480p/720p/1080p 档位。',
      },
      num_frames: {
        type: 'integer',
        description: '视频帧数,必须 ≤ 441 且满足 8n+1(如 81/121/241/441),默认 121;配合 frame_rate 24 时约 3/5/10/18 秒。',
      },
      frame_rate: {
        type: 'number',
        description: '视频帧率,支持 1–60,默认 24;更流畅的运动用 24 或 30。',
      },
      seed: {
        type: 'integer',
        description: '随机种子,设置固定值可复现生成结果。',
      },
      negative_prompt: {
        type: 'string',
        description: '反向提示词,描述需要避免的内容。',
      },
      num_inference_steps: {
        type: 'integer',
        description: '推理步数,一般不需要设置。',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          video_id: { type: 'string' },
          task_id: { type: 'string' },
          status: { type: 'string' },
          progress: { type: 'number' },
          seconds: { type: 'string' },
          size: { type: 'string' },
          url: { type: 'string' },
          size_mapping: { type: 'json' },
          error: { type: 'json' },
        },
        additionalProperties: false,
      },
      render: (args, value) => renderAgnesVideoValue(args, value),
    },
    timeoutMs: AGNES_VIDEO_TOOL_TIMEOUT_MS,
    // 仅读取外部 API,不修改父级拥有的状态。
    isConcurrencySafe: () => true,
    async execute(args, exec: ToolRunContext) {
      const credentials = ctx.get('credentials')
      if (credentials === undefined) {
        throw new Error('凭据服务不可用:无法解析 AGNES_API_KEY。')
      }
      const resolved = await credentials.resolve(credentialRef(AGNES_API_KEY_REF))
      if (resolved === undefined) {
        throw new Error('未配置 AGNES_API_KEY:请写入启动环境、$DSH_HOME/.credentials.yaml 或项目/user 的 .env,或在设置页的 Agnes 标签页中保存。')
      }
      const body = buildAgnesVideoRequestBody(args)
      const shell = ctx.shell
      const createCommand = `curl -sS --max-time ${AGNES_VIDEO_CURL_TIMEOUT_S} -X POST ${AGNES_VIDEO_API_URL} -H "Authorization: Bearer $AGNES_API_KEY" -H "Content-Type: application/json" --data-binary @- -w '\\n__AGNES_STATUS__%{http_code}'`
      const task = parseAgnesVideoTask(await runCurl(shell, resolved.value, createCommand, exec.signal, JSON.stringify(body)))
      const videoId = task.video_id ?? task.task_id ?? task.id
      if (videoId === undefined) {
        throw new Error(`Agnes API 未返回 video_id/task_id:${JSON.stringify(task)}`)
      }
      return await pollAgnesVideo(shell, resolved.value, videoId, exec.signal)
    },
  }))
}