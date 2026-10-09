#!/usr/bin/env node
/**
 * make-asset — 把母带视频压成插件随包分发的 assets/boot.mp4。
 *
 * 母带（例如 2560×1440 / 40 Mbps 的导出文件）体积太大，不适合塞进 npm 包让别人下载。
 * 开机动画只播一遍，视觉上不需要母带码率，所以统一转成：
 *
 *   H.264 High profile + AAC，yuv420p（兼容性最好的组合，Chromium/Electron 原生可播）
 *   faststart（moov 前置，边下边播）
 *   目标高度默认 1440，超过就缩，不到就不放大
 *   CRF 默认 22 + preset medium：动画内容静态帧多，这个档位通常能压到 5–10 MB
 *
 * 用法：
 *   node scripts/make-asset.mjs <母带.mp4> [--height 1440] [--crf 22] [--preset medium] [--out assets/boot.mp4]
 *
 * ffmpeg 来自 devDependency `@ffmpeg-installer/ffmpeg`（纯 npm 包，国内镜像可装，
 * 不依赖 GitHub Releases，也就不需要代理）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function usage(code) {
  console.log(
    [
      '用法: node scripts/make-asset.mjs <母带.mp4> [--height 1440] [--crf 22] [--preset medium] [--crop W:H:X:Y] [--out assets/boot.mp4]',
      '',
      '  输出永远是 H.264 + AAC + yuv420p + faststart，适合 <video> 直接播。',
      '  --crop 传 ffmpeg 语法，用来裁掉片源自带的黑边，例如 --crop 2560:1086:0:177。',
    ].join('\n'),
  )
  process.exit(code)
}

const argv = process.argv.slice(2)
if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) usage(argv.length === 0 ? 2 : 0)

let src = argv[0]
let height = 1440
let crf = 22
let preset = 'medium'
let crop = null
let out = join(ROOT, 'assets', 'boot.mp4')

for (let i = 1; i < argv.length; i += 1) {
  const flag = argv[i]
  const value = argv[i + 1]
  if (flag === '--height') height = Number(value)
  else if (flag === '--crf') crf = Number(value)
  else if (flag === '--preset') preset = value
  else if (flag === '--crop') crop = value
  else if (flag === '--out') out = isAbsolute(value) ? value : join(ROOT, value)
  else usage(2)
  i += 1
}

if (!existsSync(src)) {
  console.error(`找不到母带：${src}`)
  process.exit(2)
}

/**
 * 找一只能用的 ffmpeg。
 *
 * 顺序：FFMPEG_PATH 环境变量 → PATH → `@ffmpeg-installer/ffmpeg`（devDependency）→
 * 本机 node_modules 里的平台包。每一只都真跑一次 `-version` 才认账——
 * npm 的 optional 依赖在国内镜像上偶尔会下成**不完整**的文件，宁可当场发现，
 * 也不要等到几十分钟后 ffmpeg 报一句看不懂的错。
 */
function findFfmpeg() {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const candidates = []
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH)
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir) candidates.push(join(dir, exe))
  }
  try {
    candidates.push(require('@ffmpeg-installer/ffmpeg').path)
  } catch (error) {
    /* 没装 devDependency；后面的候选还有机会 */
  }
  candidates.push(join(ROOT, 'node_modules', '@ffmpeg-installer', `${process.platform}-${process.arch}`, exe))
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['-version'], { stdio: 'ignore' })
      return candidate
    } catch (error) {
      /* 换下一个候选 */
    }
  }
  return null
}

const ffmpegPath = findFfmpeg()
if (ffmpegPath === null) {
  console.error('找不到可用的 ffmpeg。三条路：')
  console.error('  1) 装一个：npm i -D @ffmpeg-installer/ffmpeg（国内镜像即可，不用访问 GitHub）')
  console.error('  2) 本机已经有别的 ffmpeg：设 FFMPEG_PATH=<ffmpeg 的绝对路径>')
  console.error('  3) 用国内镜像一条命令拉：node scripts/fetch-ffmpeg.mjs')
  process.exit(2)
}

mkdirSync(dirname(out), { recursive: true })

/** 不放大：源高度小于目标时就用源高度。宽度取 -2 保证偶数（libx264 要求）。 */
const scale = `scale=-2:'min(${height},ih)'`

/**
 * 片源自带的黑边要在这里裁掉，不能留给播放器。
 *
 * 实测：这条母带是 2560×1440 的 16:9 容器，但 0–6 秒的**有效画面只有 1086px 高**
 * （上下各 177px 纯黑），9 秒后画面才逐渐铺满。播放器再怎么 object-fit 也去不掉
 * "画出来的黑边"——只有先裁掉，剩下的画面才可能真正铺满屏幕。
 */
const filters = []
if (crop !== null) filters.push(`crop=${crop}`)
filters.push(scale)

const args = [
  '-hide_banner',
  '-y',
  '-i',
  src,
  '-c:v',
  'libx264',
  '-preset',
  preset,
  '-crf',
  String(crf),
  '-profile:v',
  'high',
  '-pix_fmt',
  'yuv420p',
  '-vf',
  filters.join(','),
  '-c:a',
  'aac',
  '-b:a',
  '128k',
  '-movflags',
  '+faststart',
  out,
]

console.log(`ffmpeg: ${ffmpegPath}`)
console.log(`输入: ${src}`)
console.log(`输出: ${out}`)
console.log(`参数: CRF ${crf} / preset ${preset} / 目标高度 ${height} / 裁切 ${crop ?? '无'} / AAC 128k / faststart`)

const started = Date.now()
execFileSync(ffmpegPath, args, { stdio: 'inherit' })
const seconds = ((Date.now() - started) / 1000).toFixed(1)
const mb = (statSync(out).size / 1048576).toFixed(2)
console.log(`完成：${mb} MB，用时 ${seconds}s`)
