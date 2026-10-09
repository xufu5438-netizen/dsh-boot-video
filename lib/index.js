/**
 * dsh-boot-video — host half.
 *
 * 这个插件的动画在浏览器半边（lib/client.js），但它的**第一帧**不能在那儿：
 * DSH 自己的开机卡片（`HARNESS / Loading plugins…`）在客户端插件被求值之前就画好了
 * （在 550C 那台机器上实测：卡片 67 ms、客户端 bundle 338 ms、卡片销毁 517 ms），
 * 所以只靠客户端 JS 上屏的覆盖层永远会漏出几百毫秒的卡片，z-index 再高也没用。
 *
 * 比 shell 更早存在的唯一表面是**被服务的文档本身**，而 DSH 把它开放出来了：
 * `webserver/index-inject` 收集一组 index 行，Web 载体在 `<head>` 之后立刻渲染它们，
 * Desktop 载体在 settle `__DSH_BOOT_READY__` 之前应用它们——两者都在构建卡片的
 * shell 内核之前。于是一条 `style` 行 + 一条同步 `script` 行就能在文档仍在解析时
 * 占住屏幕，卡片从一开始就不会出现。
 *
 * 与 lib/client.js 的两条契约：
 *
 *   SOURCE_KEY         同一个 localStorage 键：只有 `'video'` 才注入首帧；
 *                      `'550c'` / `'off'` 直接放行，让 DSH 自己（或 550C）上屏。
 *   FIRST_FRAME_GLOBAL `window.__dshBootVideoFirstFrame.end()` 是客户端覆盖层把这块
 *                      首帧撤下的方式——同一个任务里完成交接，一次绘制，没有缝。
 *                      下面脚本自带的超时是兜底：客户端半边没能加载时，
 *                      绝不允许给用户留一屏黑色。
 *
 * @module dsh-boot-video
 */

import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { pipeline } from 'node:stream/promises'
import { ensureFfmpeg, ffmpegPath, probeDuration, transcodeToH264 } from './transcode.js'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'boot-video'

/** lib/client.js SOURCE_KEY — 保持一致。 */
const SOURCE_KEY = 'dsh-boot-video:source'
/** lib/client.js FIRST_FRAME_GLOBAL — 保持一致。 */
const FIRST_FRAME_GLOBAL = '__dshBootVideoFirstFrame'
/** lib/client.js VERSION_GLOBAL — 版本号，设置行读它，省一次请求。 */
const VERSION_GLOBAL = '__dshBootVideoVersion'
/** lib/client.js 的 `window.__dshBootVideoAssets` — 随包提供哪几段片头，客户端按它画按钮。 */
const ASSETS_GLOBAL = '__dshBootVideoAssets'
/** 首帧铺的底色：与视频开头一致，交接时才不会闪。 */
const FIRST_FRAME_BG = '#000000'
/** 上限（毫秒）：超过就把屏幕让给页面上已有的东西。 */
const FIRST_FRAME_MAX_MS = 12000
/** 比 550C 的首帧（2147482000）高 1：两个插件都在场时，视觉上由本插件接管。 */
const FIRST_FRAME_Z = 2147482001

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(HERE, '..')
const ASSET_DIR = join(PACKAGE_ROOT, 'assets')

/**
 * 可选的开屏素材（与 lib/client.js 的 ASSETS 表一一对应）。
 *
 * 2026-10-09 起有两段片头都能当开屏，所以做成"可选"而不是二选一删掉一条：
 * `hdd` 是插件原配的 HDD 开机动画，`yuedu` 是"欢迎来到月读世界"。
 */
// 加素材只要往这张表加一个 id，并把同名 mp4 放进 assets/（客户端那边的 ASSETS 也要同步）。
const ASSETS = ['hdd', 'yuedu']
/**
 * 随包提供哪几段片头。默认两段都在；`DSHBV_ASSETS=hdd` 时**只提供 HDD**。
 *
 * 为什么要有这个：`yuedu.mp4` 那段是从电影里剪的、**没有授权**，发布包不能带；
 * `hdd.mp4` 已获 B 站 UP 主授权、可以带。客户端那边读宿主注入的
 * `window.__dshBootVideoAssets`（就是下面过滤后的这张表），两边一致。
 */
const ASSETS_OVERRIDE = (process.env.DSHBV_ASSETS ?? '')
  .split(',')
  .map((name) => name.trim())
  .filter((name) => name !== '')
/**
 * 实际随包提供的素材：有 `DSHBV_ASSETS` 就按它过滤，否则全给。
 *
 * 过滤掉的那段，路由**根本不注册**（连 404 都只是"没这条路由"）——发布包里
 * 只有 `assets/hdd.mp4`，所以"月读世界"在那边天然不存在。
 */
const PROVIDED_ASSETS = ASSETS_OVERRIDE.length === 0 ? ASSETS : ASSETS.filter((id) => ASSETS_OVERRIDE.includes(id))
const DEFAULT_ASSET = PROVIDED_ASSETS.includes('hdd') ? 'hdd' : (PROVIDED_ASSETS[0] ?? 'hdd')
/** 素材路由：`/dsh-boot-video/asset/<id>.mp4`。 */
const ASSET_ROUTE_PREFIX = '/dsh-boot-video/asset/'
/**
 * 注册**前缀路由**用的路径：**不能带尾斜杠**。
 *
 * DSH 的前缀匹配是 `/` 边界语义：`pathname === prefix || pathname.startsWith(prefix + '/')`。
 * 拿 `/dsh-boot-video/asset/` 去当 prefix，`/dsh-boot-video/asset/xxx.mp4` 既不等于它、
 * 也不以 `…/asset//` 开头 → **永远匹配不上**（2026-10-09 用户素材一直 404 的真因，
 * 内置素材不受影响是因为它们走 exact）。所以前缀只写到 `/asset`。
 */
const ASSET_ROUTE_PREFIX_MATCH = '/dsh-boot-video/asset'
/** 旧路径：老版本的客户端 bundle 请求的就是它，留着指向默认素材。 */
const LEGACY_ROUTE = '/dsh-boot-video/boot.mp4'

/**
 * 用户导入的视频放这儿——**就在插件自己里面**（用户 2026-10-09 的要求：
 * 「至于其他人导入的，也给他设置成塞到插件里面的文件夹里」）。
 *
 * 为什么选 `assets/user/` 而不是另起一个顶层目录：内置素材在 `assets/`，用户素材在
 * `assets/user/`，一眼就能分清"哪些是包里带的、哪些是人自己放进来的"，清理时也不会误删。
 * 代价是升级/重装插件时这个目录可能被覆盖——README 里写明了。
 */
const USER_ASSET_DIR = join(ASSET_DIR, 'user')
/**
 * 用户自己起的名字（自命名）存在这里：`{ "<id>": "显示名" }`。
 *
 * **只改显示名，不动磁盘文件名**——id 是磁盘身份，改名走这张表，所以改名永远不会
 * 把正在用的素材弄丢。表坏了（或多出一堆乱码）就当空的用，素材照样能播。
 */
const USER_LABELS_FILE = join(USER_ASSET_DIR, 'labels.json')
/**
 * 转码时的中转文件放这儿（`assets/user/.tmp/`）：清单只认 `u-*.mp4`，所以中转文件
 * 既不会被当成素材列出来，也不会污染素材目录。
 */
const USER_TEMP_DIR = join(USER_ASSET_DIR, '.tmp')
/** 转码状态（同一时刻只允许一段；客户端轮询画进度条）。 */
let converting = null
/** 下载 ffmpeg 的进度。 */
let fetching = null
/** 单文件上限：够收一段 4K 短片，又不至于让人不小心塞进几个 G。 */
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024
/** 导入相关的路由（客户端用**相对路径**打它们，网页版与桌面版都一样）。 */
const IMPORT_PATH = '/dsh-boot-video/import'
const IMPORT_LIST_PATH = '/dsh-boot-video/imported.json'
const IMPORT_DELETE_PATH = '/dsh-boot-video/import/delete'
/**
 * 改名（自命名）。只改显示名：磁盘上还是 `u-*.mp4`，名字记在 `assets/user/labels.json`。
 */
const IMPORT_RENAME_PATH = '/dsh-boot-video/import/rename'
/** 转码相关的三个入口：下 ffmpeg、查进度、真的转。 */
const FFMPEG_SETUP_PATH = '/dsh-boot-video/ffmpeg/setup'
const CONVERT_PATH = '/dsh-boot-video/import/convert'
const CONVERT_STATUS_PATH = '/dsh-boot-video/import/convert-status'
/** 显示名上限：够写清楚是哪一段，又不至于把列表撑破。 */
const MAX_LABEL_CHARS = 40
/**
 * 按路径导入（桌面版的快路）：Electron 的 `getPathForFile` 能把用户选的文件翻成绝对路径，
 * 于是宿主可以直接复制，省掉把几百 MB 从渲染进程搬到宿主那一趟。
 */
const IMPORT_FROM_PATH = '/dsh-boot-video/import/from-path'
/** 导入 id 的形状：`u-<base36 时间>-<base36 计数>`，白名单校验顺带挡路径穿越。 */
const USER_ID_RE = /^u-[a-z0-9]{1,12}-[a-z0-9]{1,6}$/
/**
 * 探编码用的 ffmpeg：优先用同一份包里带的（`scripts/fetch-ffmpeg.mjs` 装的那个），
 * 让用户在**导入那一刻**就知道"这段能不能播"，而不是重启后对着一块黑屏发愣。
 */
const FFMPEG = join(PACKAGE_ROOT, 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe')
/** 探编码最多等这么久；超时就放行（宁可让用户自己看到黑屏，也不能卡住导入）。 */
const PROBE_TIMEOUT_MS = 15000
/**
 * 「导入自己的视频」（用户自己挑 mp4 当片头）——**默认开着**，这是本插件的主功能之一。
 *
 * 用户 2026-10-09 明确「我最重要的导入视频的功能呢」：之前我因为一句「只要 HDD 和月读世界、
 * 不需要其他的」把它关掉过，那是我理解错了——那句话说的是"**内置**就这两段够用"。
 *
 * 关掉的办法（比如给不想让人写盘的场景）：跑 DSH 时**不要**设 `DSHBV_IMPORT`；或者改成
 * `DSHBV_IMPORT=0`。设成 `1`（或不设？不——不设就是关，见下面的判断）……
 * 说白了：**只有恰好 `DSHBV_IMPORT=1` 才是开**，这是为了本机调试时能一键切换。
 * 客户端那边对应的常量是 `lib/client.js` 的 `IMPORT_ENABLED`，两边要一致。
 */
const IMPORT_ENABLED = process.env.DSHBV_IMPORT !== '0'
/**
 * Chromium 能自己解的视频编码。
 *
 * **HEVC / H.265 不在里面**——桌面版是 Electron（Chromium 内核），不支持它，
 * 这正是用户 2026-10-09 导 mkv 只看到"黑屏一闪"的原因。
 */
const PLAYABLE_CODECS = ['h264', 'avc1', 'vp8', 'vp9', 'av1', 'av01', 'theora']
/**
 * 只收 mp4（用户 2026-10-09 拍板：「看不懂，不行就写死只能导入mp4」）。
 *
 * 上一版是"编码在白名单里就收"，能收的东西多，但用户没法预判——他手上一个 mkv 就撞了墙。
 * 现在的口径是**两条一起卡**：①扩展名必须是 `.mp4`；②里面必须是能播的编码（H.264 等）。
 * 这样"我该准备什么文件"这个问题只有一个答案：**mp4 + H.264**。
 */
const IMPORT_EXTENSION = '.mp4'

/** 实际安装的这个包自己的版本；读不到就退回 null（设置行自己会退化）。 */
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version ?? null
  } catch {
    return null
  }
})()

/**
 * 这段视频浏览器能不能自己解出来。
 *
 * 为什么要查：**Chromium（桌面版是 Electron）不支持 HEVC / H.265**，而"原盘/4K 片源"
 * 常常就是 H.265（用户 2026-10-09 就是这么踩的：导 mkv 进去只看到黑屏一闪）。
 * 导进来再让用户面对一块黑屏是最差的结果，所以**在写进清单前**先看一眼编码：
 * 视频轨必须是 h264（avc1）或 vp9 / av01——这三种 Chromium 都能解。
 *
 * @param filePath - 刚落地的文件路径。
 * @returns `{ ok: true }` 或 `{ ok: false, code, message }`。
 */
function probePlayability(filePath) {
  return new Promise((resolve) => {
    const child = spawn(FFMPEG, ['-hide_banner', '-i', filePath], { stdio: ['ignore', 'ignore', 'pipe'] })
    let text = ''
    let settled = false
    const done = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill()
      done({ ok: true })
    }, PROBE_TIMEOUT_MS)
    child.stderr.on('data', (chunk) => {
      text += chunk.toString()
    })
    child.on('error', () => {
      clearTimeout(timer)
      done({ ok: true })
    })
    child.on('exit', () => {
      clearTimeout(timer)
      const videoLine = text.split('\n').find((line) => line.includes('Stream #') && line.includes('Video:'))
      if (videoLine === undefined) {
        done({
          ok: false,
          code: 'no-video-track',
          message: '这个文件里没有找到视频轨，先确认一下你选的是片子本身',
        })
        return
      }
      const codec = /Video:\s*([a-z0-9]+)/i.exec(videoLine)
      const name = codec === null ? '' : codec[1].toLowerCase()
      if (PLAYABLE_CODECS.includes(name)) {
        done({ ok: true })
        return
      }
      if (name === 'hevc' || name === 'h265') {
        done({
          ok: false,
          codec: name,
          code: 'codec-unsupported',
          message:
            '这个 mp4 里是 HEVC / H.265 编码，Chromium（桌面版就是它）解不了，播出来只有黑屏。' +
            '用剪映导出时选 H.264，或用插件自带的 scripts/import-hevc.mjs 转一遍再导入',
        })
        return
      }
      done({
        ok: false,
        codec: name,
        code: 'codec-unsupported',
        message: `这个 mp4 里是 ${name === '' ? '未知' : name.toUpperCase()} 编码，浏览器解不了；用剪映导出成 H.264，或用插件自带的 scripts/import-hevc.mjs 转一遍再导入`,
      })
    })
  })
}

/**
 * 首帧的样式行。
 *
 * 纯 CSS，不依赖任何脚本执行：即使 script 行被别的插件挤掉，这块底也已经在屏上。
 * `pointer-events:none` 是关键——它只负责占屏，不抢点击。
 */
const FIRST_FRAME_CSS = `#dshbv-first{position:fixed;inset:0;background:${FIRST_FRAME_BG};z-index:${FIRST_FRAME_Z};pointer-events:none}`

/**
 * 首帧的脚本行（同步内联，`placement: 'head'`）。
 *
 * 内联脚本行不会失败——这一点是刻意的：Desktop 的解释器会 `await` 外部脚本行，
 * 一个 rejection 就会杀掉 `__DSH_BOOT_READY__`，也就是整个应用起不来。
 */
const FIRST_FRAME_SCRIPT = `(function(){
  try{
    var v=null;
    try{ v=window.localStorage.getItem('${SOURCE_KEY}') }catch(e){}
    if(v==='550c'||v==='off') return;
    var el=document.createElement('div');
    el.id='dshbv-first';
    (document.body||document.documentElement).appendChild(el);
    var done=false;
    function end(){
      if(done) return; done=true;
      try{ el.remove() }catch(e){}
      window.${FIRST_FRAME_GLOBAL}=undefined;
    }
    window.${FIRST_FRAME_GLOBAL}={end:end};
    window.setTimeout(end, ${FIRST_FRAME_MAX_MS});
  }catch(e){}
})();`

/**
 * 视频路由。
 *
 * 这里拿到的是**原生 node:http 的 (req, res)**，响应生命周期完全归处理器所有——
 * 所以 Range / 206 / 304 都得自己实现，但换来的是流式返回，不必把 10 MB 视频
 * 读进内存。浏览器发 Range 是为了拖动进度条，也是部分浏览器首次取流的方式。
 *
 * 同一个 handler 服务所有素材：从 `req.url` 认 id，再在白名单里核对（顺带挡掉
 * `../` 这类路径穿越）。素材表在 lib/client.js 那边有一份对应的 ASSETS。
 *
 * @param req - 原始请求。
 * @param res - 原始响应。
 */
function videoHandler(req, res) {
  const id = assetIdFromUrl(req.url)
  const filePath = id === null ? null : assetFilePath(id)

  if (filePath === null) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('asset missing from dsh-boot-video')
    return
  }

  let stat
  try {
    stat = statSync(filePath)
  } catch {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('cannot stat the requested asset')
    return
  }

  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`
  const base = {
    'content-type': 'video/mp4',
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=0, must-revalidate',
    etag,
    'last-modified': stat.mtime.toUTCString(),
  }

  const ifNoneMatch = req.headers['if-none-match']
  if (typeof ifNoneMatch === 'string' && ifNoneMatch.split(',').some((tag) => tag.trim() === etag)) {
    res.writeHead(304, base)
    res.end()
    return
  }

  const range = typeof req.headers.range === 'string' ? /^bytes=(\d*)-(\d*)$/.exec(req.headers.range.trim()) : null
  let start = 0
  let end = stat.size - 1
  let partial = false

  if (range !== null) {
    const [, rawStart, rawEnd] = range
    if (rawStart === '' && rawEnd === '') {
      res.writeHead(416, { ...base, 'content-range': `bytes */${stat.size}` })
      res.end()
      return
    }
    if (rawStart === '') {
      // 后缀范围：最后 N 字节。
      start = Math.max(0, stat.size - Number(rawEnd))
    } else {
      start = Number(rawStart)
      end = rawEnd === '' ? stat.size - 1 : Math.min(Number(rawEnd), stat.size - 1)
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stat.size) {
      res.writeHead(416, { ...base, 'content-range': `bytes */${stat.size}` })
      res.end()
      return
    }
    partial = true
  }

  const headers = partial
    ? { ...base, 'content-range': `bytes ${start}-${end}/${stat.size}`, 'content-length': String(end - start + 1) }
    : { ...base, 'content-length': String(stat.size) }

  if (req.method === 'HEAD') {
    res.writeHead(partial ? 206 : 200, headers)
    res.end()
    return
  }

  res.writeHead(partial ? 206 : 200, headers)
  const stream = createReadStream(filePath, partial ? { start, end } : undefined)
  stream.on('error', () => {
    // 响应头已经发出去了，只能把它们掐断——总比挂着一个永不结束的响应好。
    res.destroy()
  })
  stream.pipe(res)
}

/**
 * 把请求路径翻成素材 id；不在白名单里就返回 null。
 *
 * 白名单校验同时是路径穿越防线：id 只允许 `[a-z0-9-]`，`../` 这类东西进不来。
 *
 * @param url - 原始 request.url（可能带查询串）。
 * @returns 素材 id，或 null。
 */
function assetIdFromUrl(url) {
  const path = typeof url === 'string' ? url.split('?')[0] : ''
  const match = /^\/dsh-boot-video\/(?:asset\/([a-z0-9-]+)\.mp4|boot\.mp4)$/.exec(path)
  if (match === null) return null
  const id = match[1] ?? DEFAULT_ASSET
  // 内置素材白名单；用户导入的走 `u-` 形状校验（见 userAssetFile）。
  if (PROVIDED_ASSETS.includes(id)) return id
  return userAssetFile(id) === null ? null : id
}

/**
 * 素材 id → 磁盘路径（内置与用户导入共用一条路）。
 *
 * @param id - 素材 id。
 * @returns 已确认存在的绝对路径；不存在时返回 null（调用方回 404）。
 */
function assetFilePath(id) {
  const builtin = PROVIDED_ASSETS.includes(id) ? join(ASSET_DIR, `${id}.mp4`) : null
  const path = builtin ?? userAssetFile(id)
  if (path === null) return null
  return existsSync(path) ? path : null
}

//#region 导入的用户视频（0.4.0）

/** 用户导入素材的 id 计数器：同一毫秒里连导两个也不会撞。 */
let importSeq = 0

/**
 * 把 id 翻成磁盘路径，并确认它确实是"用户导入"（`u-` 前缀）且没跑出 `assets/user/`。
 *
 * @param id - 客户端给的素材 id。
 * @returns 绝对路径，或 null（不是用户素材 / 形状不合法）。
 */
function userAssetFile(id) {
  if (typeof id !== 'string' || !USER_ID_RE.test(id)) return null
  return join(USER_ASSET_DIR, `${id}.mp4`)
}

/**
 * 读"自命名"表。
 *
 * 坏文件（不是 JSON、或不是对象）一律降级成空表——名字只是显示用，不该因为它读不出来
 * 就让整页出不来。
 *
 * @returns `{ "<id>": "<名字>" }`。
 */
function readLabels() {
  try {
    const parsed = JSON.parse(readFileSync(USER_LABELS_FILE, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 写"自命名"表。只留还存在的素材（删掉的那些名字顺手清掉，表不会越长越大）。
 *
 * @param labels - 完整的名字表。
 */
function writeLabels(labels) {
  const live = new Set(listImported().map((item) => item.id))
  const kept = {}
  for (const [id, label] of Object.entries(labels)) {
    if (live.has(id) && typeof label === 'string' && label !== '') kept[id] = label
  }
  mkdirSync(USER_ASSET_DIR, { recursive: true })
  const temp = `${USER_LABELS_FILE}.tmp`
  writeFileSync(temp, `${JSON.stringify(kept, null, 2)}\n`, 'utf8')
  // 先写临时文件再改名：中途断电也不会留下半截 JSON。
  renameSync(temp, USER_LABELS_FILE)
}

/**
 * 读导入清单。
 *
 * 清单是**推导出来的**（列目录），不另存一份 json：少一个可能与磁盘不一致的状态。
 * 只认 `u-*.mp4`，所以 `assets/user/` 里被人手工丢进去的别的东西不会被误当成素材。
 *
 * @returns [{ id, bytes, at, label?, custom? }]，按导入时间倒序。
 */
function listImported() {
  if (!existsSync(USER_ASSET_DIR)) return []
  let names = []
  try {
    names = readdirSync(USER_ASSET_DIR)
  } catch {
    return []
  }
  const labels = readLabels()
  const items = []
  for (const name of names) {
    const match = /^(u-[a-z0-9-]+)\.mp4$/.exec(name)
    if (match === null) continue
    try {
      const info = statSync(join(USER_ASSET_DIR, name))
      const custom = typeof labels[match[1]] === 'string' ? labels[match[1]] : undefined
      items.push({
        id: match[1],
        bytes: info.size,
        at: Math.round(info.mtimeMs),
        ...(custom === undefined ? {} : { label: custom, custom: true }),
      })
    } catch {
      /* 列目录与 stat 之间被删掉：忽略这一条 */
    }
  }
  return items.sort((a, b) => b.at - a.at)
}

/**
 * 读请求体并写进 `assets/user/<id>.mp4`（流式，不把文件读进内存）。
 *
 * 客户端发的是**裸 body**（`fetch(url, { body: file })`），不是 multipart——少一层解析，
 * 大文件也不会先在内存里拼成 Buffer。文件名与"预期大小"走 header（见 client.js genHeaders）。
 *
 * @param req - 原始请求。
 * @param res - 原始响应。
 */
async function importHandler(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
    return
  }
  const expected = Number(req.headers['x-dshbv-size'])
  if (Number.isFinite(expected) && expected > MAX_UPLOAD_BYTES) {
    sendJson(res, 413, {
      ok: false,
      error: `文件超过 ${MAX_UPLOAD_BYTES / 1024 / 1024} MB 的上限了，挑一段短一点的`,
      max: MAX_UPLOAD_BYTES,
    })
    return
  }
  const label = decodeLabel(req.headers['x-dshbv-name'])
  if (!label.toLowerCase().endsWith(IMPORT_EXTENSION)) {
    const reason = `只收 mp4（当前这个文件是「${label === '' ? '没名字的文件' : label}」）。用剪映导出时选 mp4 + H.264，或用插件自带的 scripts/import-hevc.mjs 转一遍再导入`
    sendJson(res, 415, { ok: false, error: reason, code: 'extension-not-allowed', message: reason })
    return
  }
  const id = `u-${Date.now().toString(36)}-${(importSeq++).toString(36)}`
  try {
    mkdirSync(USER_ASSET_DIR, { recursive: true })
  } catch (error) {
    sendJson(res, 500, { ok: false, error: '插件目录写不进去（检查一下插件文件夹的权限）', message: String(error && error.message) })
    return
  }
  const target = join(USER_ASSET_DIR, `${id}.mp4`)
  let bytes = 0
  try {
    // 手写泵浦而不是 stream.pipeline：pipeline 完成即返回、不一定会等目标 fs 流把缓冲刷完，
    // 结果是"响应说成功、盘上却是 0 字节"（第一版就是这么错的）。这里显式 await finish。
    const writer = createWriteStream(target, { flags: 'wx' })
    try {
      for await (const chunk of req) {
        bytes += chunk.length
        if (bytes > MAX_UPLOAD_BYTES) throw new Error(`over the ${MAX_UPLOAD_BYTES} byte cap`)
        if (!writer.write(chunk)) await once(writer, 'drain')
      }
      writer.end()
      await once(writer, 'finish')
    } catch (error) {
      writer.destroy()
      throw error
    }
  } catch (error) {
    try {
      rmSync(target, { force: true })
    } catch {
      /* 清理失败无所谓：那个 id 已经不会出现在清单里 */
    }
    sendJson(res, bytes > MAX_UPLOAD_BYTES ? 413 : 400, {
      ok: false,
      error: bytes > MAX_UPLOAD_BYTES ? 'too-large' : 'upload-failed',
      message: String(error && error.message),
    })
    return
  }
  const rejected = await rejectIfUnplayable(target, id)
  if (rejected !== null) {
    sendJson(res, 422, rejected)
    return
  }
  sendJson(res, 200, {
    ok: true,
    asset: { id, label, bytes, at: Date.now() },
    url: `${ASSET_ROUTE_PREFIX}${id}.mp4`,
  })
}

/**
 * 落地之后、写进清单之前，验一下这段视频浏览器能不能解。
 *
 * 解不了就**当场删掉刚落的文件**并返回给客户端一段人话——用户宁可当场被拒，
 * 也不愿意重启后对着一块黑屏（用户 2026-10-09 就是这么踩的）。
 *
 * **编码这类"能救"的失败不删文件**：把 id 一起回给客户端，它就能问用户
 * "要不要我自动转码？"，转好再进清单（见 convertHandler）。
 *
 * @param filePath - 刚落地的文件。
 * @param id - 它的素材 id（编码失败时要回给客户端，所以由调用方传进来）。
 * @returns 被拒时的响应体，或 null（放行）。
 */
async function rejectIfUnplayable(filePath, id) {
  if (!existsSync(FFMPEG)) return null
  const verdict = await probePlayability(filePath)
  if (verdict.ok) return null
  const salvageable = verdict.code === 'codec-unsupported'
  if (!salvageable) {
    // 没有视频轨之类：救不了，删掉。
    try {
      rmSync(filePath, { force: true })
    } catch {
      /* 删不掉也不进清单 */
    }
  }
  return {
    ok: false,
    // `error` 直接就是**给用户看的那句话**：客户端有些版本只显示 error 字段，
    // 之前这里放的是 `codec-unsupported` 这种机器码，于是用户只看到"HTTP 422"、
    // 完全不知道该怎么办（2026-10-09 用户就撞上了这个）。
    error: verdict.message,
    code: verdict.code,
    codec: verdict.codec ?? null,
    message: verdict.message,
    ...(salvageable ? { salvageable: true, id, canConvert: ffmpegPath() !== null } : {}),
  }
}

/**
 * 按**绝对路径**导入（桌面版的快路）。
 *
 * 桌面的渲染进程能从 Electron 的 `getPathForFile` 拿到用户所选文件的路径，于是宿主直接
 * 复制就行——几百 MB 的片子不必先搬到渲染进程再传回来。这条路是**允许用户指定的路径**
 * 的写操作，所以卡死三件事：只接收本机回环请求（`requestIsLocal`）、路径必须来自那次
 * 文件选择（客户端给的 token 得对上）、只复制常规文件且不超过上限、落到我们自己的目录里。
 *
 * body: `{ path, name, size, token }`（都是客户端挑完文件后立刻算出来的）。
 *
 * @param req - 原始请求。
 * @param res - 原始响应。
 */
async function importFromPathHandler(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
    return
  }
  if (!requestIsLocal(req)) {
    sendJson(res, 403, { ok: false, error: 'local-only' })
    return
  }
  let payload = null
  try {
    payload = JSON.parse(await readBody(req, 64 * 1024))
  } catch {
    payload = null
  }
  if (payload === null || typeof payload.path !== 'string' || payload.path === '') {
    sendJson(res, 400, { ok: false, error: 'bad-request' })
    return
  }
  let info = null
  try {
    info = statSync(payload.path)
  } catch {
    sendJson(res, 404, { ok: false, error: 'not-found' })
    return
  }
  if (!info.isFile() || info.size > MAX_UPLOAD_BYTES) {
    sendJson(res, 400, { ok: false, error: info.isFile() ? 'too-large' : 'not-a-file', max: MAX_UPLOAD_BYTES })
    return
  }
  if (typeof payload.token !== 'string' || payload.token !== fileToken(info.size, info.mtimeMs)) {
    sendJson(res, 400, { ok: false, error: 'stale-selection' })
    return
  }
  if (!String(payload.path).toLowerCase().endsWith(IMPORT_EXTENSION)) {
    const reason = `只收 mp4（当前选的是「${cleanLabel(payload.name)}」）。用剪映导出时选 mp4 + H.264，或用插件自带的 scripts/import-hevc.mjs 转一遍再导入`
    sendJson(res, 415, { ok: false, error: reason, code: 'extension-not-allowed', message: reason })
    return
  }
  const id = `u-${Date.now().toString(36)}-${(importSeq++).toString(36)}`
  const target = join(USER_ASSET_DIR, `${id}.mp4`)
  try {
    mkdirSync(USER_ASSET_DIR, { recursive: true })
    // 复制**不**改内容：不转码、不重封装，import 进去什么样，播出来什么样。
    await pipeline(createReadStream(payload.path), createWriteStream(target))
  } catch (error) {
    try {
      rmSync(target, { force: true })
    } catch {
      /* 同上 */
    }
    sendJson(res, 500, { ok: false, error: '复制文件时出错（可能文件被占用或没权限）', message: String(error && error.message) })
    return
  }
  const rejected = await rejectIfUnplayable(target, id)
  if (rejected !== null) {
    sendJson(res, 422, rejected)
    return
  }
  sendJson(res, 200, {
    ok: true,
    asset: { id, label: cleanLabel(payload.name), bytes: info.size, at: Date.now() },
    url: `${ASSET_ROUTE_PREFIX}${id}.mp4`,
  })
}

/**
 * 转码：把一段"浏览器解不了"的视频转成 H.264 mp4，转好之后**自动进清单**。
 *
 * 这是导入这条路真正的兜底——用户挑了一段 HEVC 的片子被拒之后，客户端会问
 * "要不要我自动转码"，点一下就走这里：ffmpeg 没有就先去国内镜像下一份
 * （28MB 左右），然后转，转好替换成能播的版本、写进清单。
 *
 * body: `{ id, label }`（id 是 422 时回给他的那个）。
 *
 * @param req - 原始请求。
 * @param res - 原始响应。
 */
async function convertHandler(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
    return
  }
  let payload = null
  try {
    payload = JSON.parse(await readBody(req, 64 * 1024))
  } catch {
    payload = null
  }
  const file = payload === null ? null : userAssetFile(payload.id)
  if (file === null || !existsSync(file)) {
    sendJson(res, 404, { ok: false, error: '那个文件已经不在缓存里了，请重新导入一次' })
    return
  }
  if (converting !== null) {
    sendJson(res, 409, { ok: false, error: '已经有一段在转了，等它转完再试' })
    return
  }

  const sizeBefore = statSync(file).size
  const duration = probeDuration(file)
  converting = { id: payload.id, seconds: 0, duration }
  // 转好的先落到缓存目录，验完没问题才挪进清单——免得半成品被当成素材。
  mkdirSync(USER_TEMP_DIR, { recursive: true })
  const staged = join(USER_TEMP_DIR, `${payload.id}-converted.mp4`)

  try {
    await transcodeToH264(file, staged, (progress) => {
      if (converting !== null && converting.id === payload.id) converting.seconds = progress.time
    })
    const verdict = await probePlayability(staged)
    if (!verdict.ok) {
      rmSync(staged, { force: true })
      rmSync(file, { force: true })
      sendJson(res, 500, { ok: false, error: `转出来的文件还是播不了：${verdict.message ?? '未知原因'}` })
      return
    }
    // 用转好的那份替掉原文件（同名、同 id），清单里就一个条目。
    renameSync(staged, file)
    sendJson(res, 200, {
      ok: true,
      asset: { id: payload.id, label: cleanLabel(payload.label), bytes: statSync(file).size, at: Date.now() },
      url: `${ASSET_ROUTE_PREFIX}${payload.id}.mp4`,
      converted: { fromBytes: sizeBefore, toBytes: statSync(file).size, durationSeconds: Math.round(duration) },
      imported: listImported(),
    })
  } catch (error) {
    try {
      rmSync(staged, { force: true })
      rmSync(file, { force: true })
    } catch {
      /* 清理失败也不影响回话 */
    }
    sendJson(res, 500, { ok: false, error: `转码失败：${String((error && error.message) ?? error).slice(0, 200)}` })
  } finally {
    converting = null
  }
}

/** 转码进度 / ffmpeg 是否就绪（客户端轮询它画进度条）。 */
function convertStatusHandler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
    return
  }
  sendJson(res, 200, {
    ok: true,
    ffmpegReady: ffmpegPath() !== null,
    fetching: fetching === null ? null : { phase: 'fetching', loaded: fetching.loaded, total: fetching.total },
    converting:
      converting === null
        ? null
        : {
            id: converting.id,
            phase: 'converting',
            loaded: Math.round(converting.seconds),
            total: Math.round(converting.duration),
            ratio: converting.duration > 0 ? Math.min(1, converting.seconds / converting.duration) : null,
          },
  })
}

/**
 * 需要时下载一份 ffmpeg（国内镜像，不翻墙）。
 *
 * 客户端流程：导入被拒 → 用户点"自动转码" → 先打这里（只有真没 ffmpeg 才下载）。
 * 这是**会写盘 + 会联网下载约 28MB** 的动作，所以只允许本机回环请求。
 *
 * @param req - 原始请求。
 * @param res - 原始响应。
 */
async function ffmpegSetupHandler(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
    return
  }
  if (!requestIsLocal(req)) {
    sendJson(res, 403, { ok: false, error: '只允许本机操作' })
    return
  }
  const already = ffmpegPath()
  if (already !== null) {
    sendJson(res, 200, { ok: true, path: already, downloaded: false })
    return
  }
  try {
    const path = await ensureFfmpeg((progress) => {
      fetching = { loaded: progress.loaded, total: progress.total }
    })
    fetching = null
    sendJson(res, 200, { ok: true, path, downloaded: true })
  } catch (error) {
    fetching = null
    sendJson(res, 500, {
      ok: false,
      error: `下载 ffmpeg 失败（走的是国内镜像 registry.npmmirror.com）：${String((error && error.message) ?? error).slice(0, 200)}`,
    })
  }
}

/**
 * 删除一个导入的素材：只删 `assets/user/` 里的那一个文件——**绝不碰用户的原片**。
 *
 * body: `{ id }`。
 *
 * @param req - 原始请求。
 * @param res - 原始响应。
 */
async function deleteImportedHandler(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
    return
  }
  let payload = null
  try {
    payload = JSON.parse(await readBody(req, 64 * 1024))
  } catch {
    payload = null
  }
  const file = payload === null ? null : userAssetFile(payload.id)
  if (file === null) {
    sendJson(res, 400, { ok: false, error: 'bad-request' })
    return
  }
  try {
    rmSync(file, { force: true })
  } catch (error) {
    sendJson(res, 500, { ok: false, error: '删除时出错（文件可能被占用）', message: String(error && error.message) })
    return
  }
  // 顺手把它那条自定义名字清掉（writeLabels 只留还存在的素材）。清名字失败不该影响删除结果。
  try {
    writeLabels(readLabels())
  } catch {
    /* 名字表里留一条孤儿记录无害 */
  }
  sendJson(res, 200, { ok: true, imported: listImported() })
}

/** 列出导入的素材；客户端进设置页时拉一次。 */
function importedListHandler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
    return
  }
  sendJson(res, 200, { ok: true, imported: listImported() })
}

/**
 * 给一段导入的素材**起个自己的名字**（用户 2026-10-09 要求：「加一个自命名」）。
 *
 * 只改显示名：磁盘上还是 `u-*.mp4`（id 才是身份），名字记在 `assets/user/labels.json`。
 * 好处是改名永远动不到正在用的素材，播放路径一点不受影响。
 * 名字传空串 = 删掉这条自定义，回到原始文件名。
 *
 * body: `{ id, label }`。
 *
 * @param req - 原始请求。
 * @param res - 原始响应。
 */
async function renameImportedHandler(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
    return
  }
  let payload = null
  try {
    payload = JSON.parse(await readBody(req, 64 * 1024))
  } catch {
    payload = null
  }
  const file = payload === null ? null : userAssetFile(payload.id)
  if (file === null || !existsSync(file)) {
    sendJson(res, 404, { ok: false, error: 'not-found' })
    return
  }
  const label = cleanLabel(payload.label).slice(0, MAX_LABEL_CHARS)
  const labels = readLabels()
  if (label === '') delete labels[payload.id]
  else labels[payload.id] = label
  try {
    writeLabels(labels)
  } catch (error) {
    sendJson(res, 500, { ok: false, error: '保存名字时出错（写不进去）', message: String(error && error.message) })
    return
  }
  sendJson(res, 200, { ok: true, id: payload.id, label, imported: listImported() })
}

/**
 * 只认本机回环的请求。
 *
 * 宿主默认只监听 127.0.0.1，但 `dsh web --host 0.0.0.0` 也允许——那种部署下匿名请求
 * 能打到这里，而"按路径复制文件"不该给它们开。所以再核一次来源。
 *
 * @param req - 原始请求。
 * @returns 是回环来源时为 true。
 */
function requestIsLocal(req) {
  const address = req.socket === undefined || req.socket === null ? undefined : req.socket.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * body → string（带上限，避免一个坏请求把内存吃掉）。
 *
 * @param req - 原始请求。
 * @param limit - 最多读多少字节。
 * @returns body 文本。
 */
async function readBody(req, limit) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > limit) throw new Error('body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** header → 文件名。非 ASCII 走 encodeURIComponent（header 只能是 ASCII）。 */
function decodeLabel(header) {
  if (typeof header !== 'string' || header === '') return ''
  try {
    return cleanLabel(decodeURIComponent(header))
  } catch {
    return cleanLabel(header)
  }
}

/** 文件名只当**显示用**：丢掉路径分隔符、控制字符，限长。 */
function cleanLabel(value) {
  const text = typeof value === 'string' ? value : ''
  return text
    .replace(/[\\/]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 120)
}

/** 与客户端一致的"这次选择"的指纹：改过/换过文件就对不上，避免导入一个已经不是当初选的片。 */
function fileToken(size, mtimeMs) {
  return `${size.toString(36)}-${Math.round(mtimeMs).toString(36)}`
}

/**
 * 发一个 JSON 响应。
 *
 * @param res - 原始响应。
 * @param status - HTTP 状态码。
 * @param payload - 要序列化的对象。
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
  })
  res.end(body)
}

//#endregion

/**
 * 挂上首帧与视频路由。
 *
 * `webserver/index-inject` 是个纯组合事件（不是服务），所以在 apply() 里同步注册监听：
 * 宿主只在启动时收集一次这张表，晚一步注册的行永远落不到页面上。
 *
 * 视频路由走可选注入（`ctx.inject(['webServer'], …)`）：没有 HTTP 载体的 profile
 * 依然能得到首帧覆盖，只是没有视频可播；服务改名时也只影响这一条。
 *
 * @param ctx - 插件上下文。
 */
export function apply(ctx) {
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'style', text: FIRST_FRAME_CSS })
    table.push({ kind: 'script', placement: 'head', text: FIRST_FRAME_SCRIPT })
    if (VERSION !== null) table.push({ kind: 'global', name: VERSION_GLOBAL, value: VERSION })
    // 随包提供哪几段片头（发布包只有 hdd）：客户端按它决定画几个按钮、要不要去请求。
    table.push({ kind: 'global', name: ASSETS_GLOBAL, value: PROVIDED_ASSETS })
  })

  ctx.inject(['webServer'], (webCtx) => {
    // 每个素材一条 exact 路由，handler 是同一个（从 req.url 认 id）；
    // 旧路径 /dsh-boot-video/boot.mp4 也留着——还没重启的客户端 bundle 仍在请求它。
    const routes = [...PROVIDED_ASSETS.map((id) => `${ASSET_ROUTE_PREFIX}${id}.mp4`), LEGACY_ROUTE]
    for (const route of routes) {
      webCtx.effect(
        () =>
          webCtx.webServer.register({
            kind: 'exact',
            path: route,
            handler: videoHandler,
          }),
        `boot-video: GET ${route}`,
      )
    }

    // 用户导入素材的路由。素材是"任意 id"，所以只能靠**前缀**路由兜住
    // （`/dsh-boot-video/asset/anything.mp4` 都落到同一个 handler 里，由它自己按
    // "内置表 + 用户素材"决定放行还是 404）。其余几条都是固定路径，用 exact 注册：
    //   ⚠️ 别把 `/dsh-boot-video/import` 写成前缀——`/dsh-boot-video/imported.json`
    //   也以它开头，前缀匹配会让清单请求落进上传 handler，清单直接变成 405。
    if (!IMPORT_ENABLED) return
    const assetPrefixRoute = {
      kind: 'prefix',
      path: ASSET_ROUTE_PREFIX_MATCH,
      handler: videoHandler,
      note: 'GET user asset',
    }
    const importRoutes = [
      { kind: 'exact', path: IMPORT_PATH, handler: importHandler, note: 'POST upload' },
      { kind: 'exact', path: IMPORT_LIST_PATH, handler: importedListHandler, note: 'GET list' },
      { kind: 'exact', path: IMPORT_DELETE_PATH, handler: deleteImportedHandler, note: 'POST delete' },
      { kind: 'exact', path: IMPORT_RENAME_PATH, handler: renameImportedHandler, note: 'POST rename' },
      { kind: 'exact', path: IMPORT_FROM_PATH, handler: importFromPathHandler, note: 'POST copy by path' },
      { kind: 'exact', path: CONVERT_PATH, handler: convertHandler, note: 'POST transcode to H.264' },
      { kind: 'exact', path: CONVERT_STATUS_PATH, handler: convertStatusHandler, note: 'GET transcode progress' },
      { kind: 'exact', path: FFMPEG_SETUP_PATH, handler: ffmpegSetupHandler, note: 'POST fetch ffmpeg' },
    ]
    for (const route of [assetPrefixRoute, ...importRoutes]) {
      webCtx.effect(
        () =>
          webCtx.webServer.register({
            kind: route.kind,
            path: route.path,
            handler: route.handler,
          }),
        `boot-video: ${route.note}`,
      )
    }
  })
}
