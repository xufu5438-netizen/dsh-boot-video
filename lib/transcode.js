/**
 * 转码（把 Chrome 解不了的视频变成能播的 H.264 mp4）。
 *
 * 为什么要它：**Chromium 不支持 HEVC / H.265**，而"原盘/4K 片源"多半就是 H.265；
 * 用户 2026-10-09 导入 `欢迎来到月读世界（原版）.mp4` 就被拒了——他不可能自己去学命令行。
 * 所以让插件自己带一套：ffmpeg 没装就**从国内镜像下载**（不翻墙），下好了自己转。
 *
 * 两条来源，按顺序找：
 *   ① `node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe`（开发时 `npm run ffmpeg` 装的）
 *   ② `bin/ffmpeg.exe`（插件自己下载的；见 ensureFfmpeg）
 */
import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(HERE, '..')
/** 开发时那份（scripts/fetch-ffmpeg.mjs 装的）。 */
const DEV_FFMPEG = join(PACKAGE_ROOT, 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe')
/** 插件自己下载的那份。 */
const LOCAL_FFMPEG = join(PACKAGE_ROOT, 'bin', 'ffmpeg.exe')
/** 只走国内镜像（校园网 + 不翻墙）。 */
const MIRROR_BASE = 'https://registry.npmmirror.com/-/binary/ffmpeg-static'
/** 试这几个版本，谁在就下谁（新版优先）。 */
const CANDIDATE_VERSIONS = ['b6.1.1', 'b6.0', 'b5.0.1']
const DOWNLOAD_TIMEOUT_MS = 600000
/** 转码上限：超过就放弃（4K 长片 CPU 转很慢，宁可让用户自己剪短）。 */
const TRANSCODE_TIMEOUT_MS = 1800000

/** 现在能用哪份 ffmpeg；都没有返回 null。 */
export function ffmpegPath() {
  if (existsSync(DEV_FFMPEG)) return DEV_FFMPEG
  if (existsSync(LOCAL_FFMPEG)) return LOCAL_FFMPEG
  return null
}

/** 二进制是不是真的能跑（下载解包后必须验一次）。 */
export function ffmpegWorks(path) {
  const result = spawnSync(path, ['-version'], { encoding: 'utf8' })
  return result.status === 0 && String(result.stdout ?? '').includes('ffmpeg version')
}

/**
 * 没装 ffmpeg 就从国内镜像下一份到 `bin/ffmpeg.exe`。
 *
 * @param onProgress - 进度回调 `{ loaded, total }`。
 * @returns 可用的路径。
 * @throws 下载或校验失败时抛错（消息给人看）。
 */
export async function ensureFfmpeg(onProgress) {
  const existing = ffmpegPath()
  if (existing !== null && ffmpegWorks(existing)) return existing

  mkdirSync(dirname(LOCAL_FFMPEG), { recursive: true })
  const errors = []

  for (const version of CANDIDATE_VERSIONS) {
    const url = `${MIRROR_BASE}/${version}/ffmpeg-win32-x64.gz`
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
      if (!response.ok) {
        errors.push(`${version}: HTTP ${response.status}`)
        continue
      }
      const tempDir = mkdtempSync(join(tmpdir(), 'dshbv-ffmpeg-'))
      const gzPath = join(tempDir, 'ffmpeg.gz')
      const total = Number(response.headers.get('content-length') ?? 0)
      let loaded = 0
      const reader = response.body.getReader()
      const sink = createWriteStream(gzPath)
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done === true) break
          loaded += value.length
          if (onProgress !== undefined) onProgress({ loaded, total })
          if (!sink.write(Buffer.from(value))) {
            await new Promise((resolve) => sink.once('drain', resolve))
          }
        }
      } finally {
        sink.end()
        await new Promise((resolve) => sink.once('finish', resolve))
      }

      // Windows 的 ffmpeg-static 包是 gz 单独一个 exe（不是 zip），用 tar 解最省事：
      // tar 能处理 .gz 吗？不能——所以走 zlib 的 gunzip（node 内置）。
      const { createReadStream } = await import('node:fs')
      const { createGunzip } = await import('node:zlib')
      await pipeline(createReadStream(gzPath), createGunzip(), createWriteStream(LOCAL_FFMPEG))

      rmSync(tempDir, { recursive: true, force: true })

      if (!ffmpegWorks(LOCAL_FFMPEG)) {
        rmSync(LOCAL_FFMPEG, { force: true })
        errors.push(`${version}: 解出来的 ffmpeg 跑不起来`)
        continue
      }
      return LOCAL_FFMPEG
    } catch (error) {
      errors.push(`${version}: ${String(error && error.message)}`)
    }
  }

  throw new Error(`下载 ffmpeg 失败（试过 ${CANDIDATE_VERSIONS.join(' / ')}）：${errors.join('；')}`)
}

/**
 * 用 ffmpeg 简单读一眼输入文件的编码（不需要 ffprobe）。
 *
 * @param filePath - 要看的文件。
 * @returns `{ codec, line }`——codec 是视频轨编码名（小写），读不到返回空串。
 */
export function probeCodec(filePath) {
  const ffmpeg = ffmpegPath()
  if (ffmpeg === null) return { codec: '', line: '' }
  const result = spawnSync(ffmpeg, ['-hide_banner', '-i', filePath], { encoding: 'utf8', timeout: 20000 })
  const text = `${result.stderr ?? ''}`
  const line = text.split('\n').find((row) => row.includes('Stream #') && row.includes('Video:')) ?? ''
  const match = /Video:\s*([a-z0-9]+)/i.exec(line)
  return { codec: match === null ? '' : match[1].toLowerCase(), line: line.trim() }
}

/**
 * 把一段视频转成能播的 H.264 mp4（同尺寸、保原帧率、AAC 音频、faststart）。
 *
 * @param input - 源文件。
 * @param output - 目标文件（会覆盖）。
 * @param onProgress - 进度回调 `{ time, ratio, speed }`（ratio 可能为 null：读不到总时长时）。
 * @returns 转码后的文件大小。
 */
export async function transcodeToH264(input, output, onProgress) {
  const ffmpeg = ffmpegPath()
  if (ffmpeg === null) throw new Error('还没装 ffmpeg（先调用 ensureFfmpeg）')

  const duration = probeDuration(input)
  const args = [
    '-hide_banner',
    '-y',
    '-i', input,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    output,
  ]

  await new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let tail = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('转码超时（超过 30 分钟），建议先把片子剪短一点'))
    }, TRANSCODE_TIMEOUT_MS)

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString()
      tail = `${tail}${text}`.slice(-4000)
      const match = /time=(\d+):(\d+):(\d+\.?\d*)/.exec(text)
      if (match !== null && onProgress !== undefined) {
        const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
        onProgress({
          time: seconds,
          ratio: duration > 0 ? Math.min(1, seconds / duration) : null,
          speed: (/speed=\s*([\d.]+)x/.exec(text) ?? [])[1] ?? null,
        })
      }
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg 退出码 ${String(code)}：${tail.split('\n').slice(-4).join(' ').slice(0, 300)}`))
    })
  })

  return statSync(output).size
}

/** 读时长（秒）；读不到返回 0（进度就只显示走了多久）。 */
export function probeDuration(filePath) {
  const ffmpeg = ffmpegPath()
  if (ffmpeg === null) return 0
  const result = spawnSync(ffmpeg, ['-hide_banner', '-i', filePath], { encoding: 'utf8', timeout: 20000 })
  const match = /Duration:\s*(\d+):(\d+):(\d+\.?\d*)/.exec(`${result.stderr ?? ''}`)
  if (match === null) return 0
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

/** 清理一次转码的临时文件（失败时用）。 */
export function cleanupTemp(dir) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 清不掉就算了，反正在临时目录里 */
  }
}

/** 临时目录里还剩什么（调试用）。 */
export function listTemp() {
  try {
    return readdirSync(tmpdir()).filter((name) => name.startsWith('dshbv-'))
  } catch {
    return []
  }
}
