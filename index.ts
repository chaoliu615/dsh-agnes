import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'

import { applyAgnesTool, RATIOS, SIZE_TIERS } from './image.ts'
import { applyAgnesVideoTool } from './video.ts'
export const name = 'dsh-agnes'

/** 所需服务。 */
export const inject = ['tools', 'shell']

/** 设置命名空间；浏览器端会再次声明。 */
export const AGNES_SETTINGS_NAMESPACE = settingsNamespace('agnes')

/** 支持的尺寸档位。 */
export type AgnesSizeTier = typeof SIZE_TIERS[number]

/** 支持的宽高比。 */
export type AgnesRatio = typeof RATIOS[number]

/** 插件配置。 */
export interface Config {
  /** 调用省略 `size` 时的默认尺寸档位。 */
  defaultSize: AgnesSizeTier
  /** 调用省略 `ratio` 时的默认宽高比。 */
  defaultRatio: AgnesRatio
}

export const Config: z<Config> = z.object({
  defaultSize: z.union([...SIZE_TIERS]).default('1K'),
  defaultRatio: z.union([...RATIOS]).default('1:1'),
})

/**
 * 注册工具并连接设置命名空间。
 * 每次调用读取命名空间的解析值，因此设置修改无需重启即可生效。
 */
export function apply(ctx: Context, config: Config): void {
  let source = () => config
  installSettingsSection(ctx, AGNES_SETTINGS_NAMESPACE, Config, config, {
    setSource: (current) => { source = current },
    onChange: () => {},
  })
  applyAgnesTool(ctx, () => source())
  applyAgnesVideoTool(ctx)
}