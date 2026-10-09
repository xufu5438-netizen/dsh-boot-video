/**
 * 把 HEVC(10bit) 的母带转成 Chromium 能播的 H.264 8bit mp4，丢进插件的用户素材目录。
 *
 * 为什么必须转：桌面版是 Electron（Chromium 内核），**不支持 HEVC / H.265**，
 * 导进去只有黑屏一闪；H.264 才是通用可播的。
 *
 * 参数：CRF 20（视觉无损档）、preset medium、保留 4K60、音频 AAC 192k、+faststart
 * （faststart 让 moov 前置，起播不用等整个文件）。
 *
 * 用法：node scripts/import-hevc.mjs "<源文件>" [输出名前缀]
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(HERE, '..')
const FFMPEG = join(PACKAGE_ROOT, 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe')
const USER_DIR = join(PACKAGE_ROOT, 'assets', 'user')

const source = process.argv[2]
if (source === undefined || !existsSync(source)) {
  console.error('用法：node scripts/import-hevc.mjs "<源文件>"')
  process.exit(1)
}

const id = `u-${Date.now().toString(36)}-0`
const target = join(USER_DIR, `${id}.mp4`)
mkdirSync(USER_DIR, { recursive: true })

const args = [
  '-hide_banner',
  '-y',
  '-i', resolve(source),
  '-c:v', 'libx264',
  '-preset', 'medium',
  '-crf', '20',
  '-pix_fmt', 'yuv420p',
  '-c:a', 'aac',
  '-b:a', '192k',
  '-movflags', '+faststart',
  target,
]

console.log(`源文件：${source}`)
console.log(`输出：  ${target}`)
console.log('开始转码（4K60 大概要几分钟，中途会打印进度）…')

const child = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] })
let tail = ''
child.stderr.on('data', (chunk) => {
  const text = chunk.toString()
  tail = `${tail}${text}`.slice(-4000)
  const match = /time=(\d+:\d+:\d+\.\d+)/.exec(text)
  if (match !== null) process.stdout.write(`\r  已转 ${match[1]}   `)
})
child.on('exit', (code) => {
  process.stdout.write('\n')
  if (code !== 0) {
    console.error('转码失败，最后几行输出：')
    console.error(tail.split('\n').slice(-12).join('\n'))
    process.exit(code ?? 1)
  }
  const info = statSync(target)
  console.log(`完成：${(info.size / 1024 / 1024).toFixed(2)} MB`)
  console.log(`素材 id：${id}（在设置页「我导入的视频」里就能看到）`)
})
