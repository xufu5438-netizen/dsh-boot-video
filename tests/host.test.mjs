/**
 * 宿主半边的路由契约测试。
 *
 * 直接驱动真实的 apply()，把 webServer.register 记下来，再用真 HTTP 服务器打这些请求。
 * 覆盖的是浏览器真正会用的东西：整段 GET、单段 Range、后缀 Range、越界 416、HEAD、
 * ETag 304。素材不存在时整组跳过（还没跑 make-asset 的机器不该因此变红）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply } from '../lib/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const VIDEO = join(ROOT, 'assets', 'hdd.mp4')
const hasVideo = existsSync(VIDEO)
/** 用户导入的视频落在这儿（lib/index.js 的 USER_ASSET_DIR）。 */
const USER_DIR = join(ROOT, 'assets', 'user')
/** 用户素材的 id 形状。 */
const USER_ID = /^u-[a-z0-9-]+$/
/** 自命名表（lib/index.js USER_LABELS_FILE）。 */
const LABELS_FILE = join(USER_DIR, 'labels.json')
/**
 * 宿主探编码用的 ffmpeg；有它才会校验"能不能播"、才会跑转码。
 *
 * 两处都找：①开发时 `npm run ffmpeg` 装到 node_modules 的那份；
 * ②插件自己从国内镜像下载后放在 `bin/ffmpeg.exe` 的那份（0.9.0 起用户机器上多半是这个）。
 * 早前只探①，于是"本机能转码"这件事在测试里被误判成"没装 ffmpeg"、白跳两条用例。
 */
const FFMPEG_CANDIDATES = [
  join(ROOT, 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe'),
  join(ROOT, 'bin', 'ffmpeg.exe'),
  // 本机开发时它装在**工作区根**的 node_modules 里（不是插件目录下）
  join(ROOT, '..', 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe'),
]
const FFMPEG = FFMPEG_CANDIDATES.find((candidate) => existsSync(candidate)) ?? FFMPEG_CANDIDATES[0]
const hasFfmpeg = existsSync(FFMPEG)
/**
 * 样本目录：**放在工作区里**，不放系统临时目录——本机的沙箱只允许写工作区，
 * ffmpeg 往 `%TEMP%` 写会直接 Permission denied（跑测试的坑，记一下）。
 */
const FIXTURE_DIR = hasFfmpeg ? mkdtempSync(join(ROOT, '.fixtures-')) : null

/** 用 ffmpeg 现造一段几帧的真视频（上传用例得喂真片子，否则会被编码校验拒掉）。 */
function makeVideo(name, args) {
  const target = join(FIXTURE_DIR, name)
  const result = spawnSync(
    FFMPEG,
    ['-hide_banner', '-loglevel', 'error', '-y', ...args, target],
    { encoding: 'utf8' },
  )
  assert.equal(result.status, 0, `造样本失败：${name}\n${result.stderr ?? ''}`)
  return target
}

/** H.264 的真 mp4（浏览器能播，所以能过校验）。 */
const H264_SAMPLE = hasFfmpeg
  ? makeVideo('h264.mp4', [
      '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=10:d=0.4',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    ])
  : null

/** 一段 HEVC 的真 mp4（Chromium 解不了，用来验证"导入时就拦住"）。 */
const HEVC_SAMPLE = hasFfmpeg
  ? makeVideo('hevc.mp4', ['-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=10:d=0.4', '-c:v', 'libx265', '-pix_fmt', 'yuv420p'])
  : null

/** 一段 HEVC 的 mkv（用户 2026-10-09 踩过的那个形状）。 */
const HEVC_MKV_SAMPLE = hasFfmpeg
  ? makeVideo('hevc.mkv', ['-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=10:d=0.4', '-c:v', 'libx265', '-pix_fmt', 'yuv420p'])
  : null

/** 上传用例要喂的字节：有 ffmpeg 就喂真 H.264，没有就退回普通字节（那时宿主也不校验）。 */
function uploadBytes() {
  return H264_SAMPLE === null ? Buffer.from('伪 mp4 内容：只需要确认字节一个不多一个不少地落地') : readFileSync(H264_SAMPLE)
}

/** 临时目录 + 清理。 */
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 直接问路由要一份清单（清单接口是 GET，正好用得上）。 */
async function listVia(server) {
  const response = await fetch(`${server.url}/dsh-boot-video/imported.json`)
  const payload = await response.json()
  return payload.imported
}

/** 数一数 `assets/user/` 以前留下的文件，用例结束时好还原现场。 */
function snapshotUserDir() {
  if (!existsSync(USER_DIR)) return []
  return readdirSync(USER_DIR).filter((name) => USER_ID.test(name.replace(/\.mp4$/, '')))
}

/**
 * 导入功能默认**关闭**（发布版只有内置两段），所以导入相关的用例都得在带
 * `DSHBV_IMPORT=1` 的子进程里跑；这条辅助把"开关打开时注册了哪些路由"取回来。
 *
 * 子进程只回传 `{kind, path}` 摘要——真正的 handler 不在这个进程里，所以导入用例
 * 是把这些路由喂给 `serve()` 之后，靠 HTTP 打它们（这也正是要测的那一层）。
 */
function driveWithImportEnabled() {
  const script = `
    import { apply } from ${JSON.stringify(join(ROOT, 'lib', 'index.js'))}
    const routes = []
    apply({
      on() {},
      inject(services, callback) {
        callback({
          effect: (fn) => fn(),
          webServer: { register(route) { routes.push({ kind: route.kind, path: route.path }); return () => {} } },
        })
      },
    })
    process.stdout.write(JSON.stringify(routes))
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, DSHBV_IMPORT: '1' },
  })
  assert.equal(result.status, 0, `带 DSHBV_IMPORT=1 的子进程应当能跑通：${result.stderr ?? ''}`)
  return JSON.parse(result.stdout)
}

/**
 * 在**只提供 HDD**（`DSHBV_ASSETS=hdd`）的子进程里跑一遍 apply()，返回路由与 index 注入行。
 *
 * 这是"发布形态"：月读世界那段没授权、不进包，所以它连路由都不该注册。
 */
function driveWithHddOnly() {
  const script = `
    import { pathToFileURL } from 'node:url'
    const { apply } = await import(pathToFileURL(${JSON.stringify(join(ROOT, 'lib', 'index.js'))}).href)
    const routes = []
    const injections = []
    apply({
      on(event, handler) { if (event === 'webserver/index-inject') injections.push(handler) },
      inject(services, callback) {
        callback({
          effect: (fn) => fn(),
          webServer: { register(route) { routes.push({ kind: route.kind, path: route.path }); return () => {} } },
        })
      },
    })
    const table = []
    for (const push of injections) push(table)
    process.stdout.write(JSON.stringify({ routes, table }))
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, DSHBV_ASSETS: 'hdd' },
  })
  assert.equal(result.status, 0, `带 DSHBV_ASSETS=hdd 的子进程应当能跑通：${result.stderr ?? ''}`)
  return JSON.parse(result.stdout)
}

/** 用最小假上下文跑一遍 apply()，把注册到的路由与注入行取出来。 */
function drive() {
  const routes = []
  const injections = []
  const ctx = {
    on(event, handler) {
      if (event === 'webserver/index-inject') injections.push(handler)
    },
    inject(services, callback) {
      assert.deepEqual(services, ['webServer'])
      callback({
        effect(fn) {
          return fn()
        },
        webServer: {
          register(route) {
            routes.push(route)
            return () => {}
          },
        },
      })
    },
  }
  apply(ctx)
  return { routes, injections }
}

/**
 * 在**带 `DSHBV_IMPORT=1` 的子进程里**起一个 HTTP 服务器，把插件挂上去。
 *
 * 为什么要子进程：`IMPORT_ENABLED` 是模块**导入时**读的环境变量，本进程里已经定死了。
 * 子进程只对外吐一行 `{"port":N}`，之后所有请求都走真 HTTP——这也正是要验的那一层。
 *
 * @returns `{ port, close() }`。
 */
async function serveWithImportEnabled() {
  const script = `
    import { createServer } from 'node:http'
    import { pathToFileURL } from 'node:url'
    const { apply } = await import(pathToFileURL(${JSON.stringify(join(ROOT, 'lib', 'index.js'))}).href)
    const routes = []
    apply({
      on() {},
      inject(services, callback) {
        callback({
          effect: (fn) => fn(),
          webServer: { register(route) { routes.push(route); return () => {} } },
        })
      },
    })
    const server = createServer((req, res) => {
      const path = (req.url ?? '').split('?')[0]
      const route =
        routes.find((r) => r.kind === 'exact' && r.path === (req.url ?? '')) ??
        routes.find((r) => r.kind === 'prefix' && (path === r.path || path.startsWith(r.path + '/')))
      if (route === undefined) { res.writeHead(404); res.end(); return }
      route.handler(req, res)
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    process.stdout.write(JSON.stringify({ port: server.address().port, routes: routes.map((r) => ({ kind: r.kind, path: r.path })) }))
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, DSHBV_IMPORT: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let childError = ''
  child.stderr.on('data', (chunk) => {
    childError += chunk.toString()
  })
  const info = await new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error(`子进程没在 15 秒内报出端口：${childError}`)), 15000)
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString()
      try {
        const parsed = JSON.parse(buffer)
        clearTimeout(timer)
        resolve(parsed)
      } catch {
        /* 还没吐完整，继续等 */
      }
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`子进程提前退出（code ${code}）：${childError}`))
    })
  })
  return {
    url: `http://127.0.0.1:${info.port}`,
    registered: info.routes,
    close: () => child.kill(),
  }
}

/** 起一个只认这些路由的服务器，返回基址与关闭函数。 */
async function serve(routes) {
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]
    // 与 webServer 的语义一致：exact 优先，前缀路由只在前缀上匹配。
    const route =
      routes.find((r) => r.kind === 'exact' && r.path === (req.url ?? '')) ??
      routes.find((r) => r.kind === 'prefix' && path.startsWith(r.path))
    if (route === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    route.handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  // keep-alive 连接会让 server.close() 永远不回调（断言失败、响应体没读完时尤其明显），
  // 所以先掐连接再关——否则一条失败的断言会把整轮测试挂死在 90 秒超时上。
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

test('apply() 默认挂上内置两段 + 导入那套（导入是主功能，默认开着）', () => {
  const { routes, injections } = drive()
  const exact = routes.filter((route) => route.kind === 'exact').map((route) => route.path)
  const prefix = routes.filter((route) => route.kind === 'prefix').map((route) => route.path)
  for (const path of [
    '/dsh-boot-video/asset/hdd.mp4',
    '/dsh-boot-video/asset/yuedu.mp4',
    '/dsh-boot-video/boot.mp4',
    '/dsh-boot-video/import',
    '/dsh-boot-video/imported.json',
    '/dsh-boot-video/import/delete',
    '/dsh-boot-video/import/rename',
    '/dsh-boot-video/import/from-path',
  ]) {
    assert.ok(exact.includes(path), `默认就该注册 ${path}`)
  }
  assert.ok(prefix.includes('/dsh-boot-video/asset'), '用户素材走前缀路由')
  assert.equal(prefix.length, 1, '前缀路由只该有用户素材那一条')
  for (const route of routes) assert.equal(typeof route.handler, 'function')

  assert.equal(injections.length, 1)
  const table = []
  injections[0](table)
  const kinds = table.map((row) => row.kind)
  assert.ok(kinds.includes('style'), 'style 行负责先铺底')
  assert.ok(kinds.includes('script'), 'script 行负责撤掉这块底')
  const script = table.find((row) => row.kind === 'script')
  assert.equal(script.placement, 'head')
  // 绝不能是 script-src：Desktop 的解释器会 await 外部脚本行，rejection 会杀掉开机流程。
  assert.notEqual(script.kind, 'script-src')
  assert.match(script.text, /__dshBootVideoFirstFrame/)
  assert.match(script.text, /dsh-boot-video:source/)
})

test('DSHBV_IMPORT=1 时才挂上用户素材与四条导入接口（前缀不能带尾斜杠）', async () => {
  const server = await serveWithImportEnabled()
  const { registered } = server
  const exact = registered.filter((route) => route.kind === 'exact').map((route) => route.path)
  const prefix = registered.filter((route) => route.kind === 'prefix').map((route) => route.path)
  // 导入的用户素材是"任意 id"，只能由前缀路由兜住，不能跟内置素材一条条列。
  assert.ok(prefix.includes('/dsh-boot-video/asset'), '用户素材走前缀路由')
  // ⚠️ 前缀**不能带尾斜杠**：DSH 的前缀匹配是 `/` 边界语义，带了就永远匹配不上
  // （2026-10-09 用户素材一直 404 的真因）。这条断言就是那次的回归测试。
  assert.equal(prefix.includes('/dsh-boot-video/asset/'), false, '前缀路由不能带尾斜杠')
  assert.equal(prefix.length, 1, '前缀路由只该有用户素材那一条')
  for (const path of [
    '/dsh-boot-video/import',
    '/dsh-boot-video/imported.json',
    '/dsh-boot-video/import/delete',
    '/dsh-boot-video/import/rename',
    '/dsh-boot-video/import/from-path',
  ]) {
    assert.ok(exact.includes(path), `${path} 要用 exact 注册`)
    // 反面：`/dsh-boot-video/import` 一旦写成前缀，`/imported.json` 也会落进上传 handler。
    assert.equal(prefix.includes(path), false, `${path} 不能是前缀路由，否则会吃掉别的路径`)
  }

  // 顺带证明"开关打开之后，用户素材真的服务得出来"——那条前缀路由是活的
  const anyUserAsset = await fetch(`${server.url}/dsh-boot-video/asset/u-zzzz-1.mp4`)
  assert.equal(anyUserAsset.status, 404, '不存在的用户素材是干净的 404（说明前缀路由确实接住了它）')
  server.close()
})

test('DSHBV_IMPORT=0 时把导入那套关掉：只剩素材路由，没有任何写盘入口', () => {
  const script = `
    import { pathToFileURL } from 'node:url'
    const { apply } = await import(pathToFileURL(${JSON.stringify(join(ROOT, 'lib', 'index.js'))}).href)
    const routes = []
    apply({
      on() {},
      inject(services, callback) {
        callback({
          effect: (fn) => fn(),
          webServer: { register(route) { routes.push({ kind: route.kind, path: route.path }); return () => {} } },
        })
      },
    })
    process.stdout.write(JSON.stringify(routes.map((route) => route.kind + ' ' + route.path)))
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, DSHBV_IMPORT: '0' },
  })
  assert.equal(result.status, 0, `DSHBV_IMPORT=0 的子进程应当能跑通：${result.stderr ?? ''}`)
  const routes = JSON.parse(result.stdout)
  assert.deepEqual(
    routes.sort(),
    [
      'exact /dsh-boot-video/asset/hdd.mp4',
      'exact /dsh-boot-video/asset/yuedu.mp4',
      'exact /dsh-boot-video/boot.mp4',
    ].sort(),
    '关掉导入后应当只剩这三条素材路由',
  )
})

test('DSHBV_ASSETS=hdd（发布形态）：只注册 HDD 那条素材路由，并把可提供的素材注入给客户端', () => {
  const { routes, table } = driveWithHddOnly()
  const exact = routes.filter((route) => route.kind === 'exact').map((route) => route.path)
  assert.ok(exact.includes('/dsh-boot-video/asset/hdd.mp4'), 'HDD 那条要在')
  assert.equal(exact.includes('/dsh-boot-video/asset/yuedu.mp4'), false, '没授权的那段连路由都不该注册')

  const assetsGlobal = table.find((row) => row.kind === 'global' && row.name === '__dshBootVideoAssets')
  assert.ok(assetsGlobal !== undefined, '要把"随包提供哪几段"告诉客户端')
  assert.deepEqual(assetsGlobal.value, ['hdd'])
})

test('视频路由：整段 / Range / 后缀 Range / 416 / HEAD / 304', { skip: !hasVideo && '还没有 assets/hdd.mp4，先跑 npm run asset' }, async () => {
  const { routes } = drive()
  const server = await serve(routes)
  const size = statSync(VIDEO).size
  const head = `${server.url}/dsh-boot-video/asset/hdd.mp4`

  try {
    // 整段
    const full = await fetch(head)
    assert.equal(full.status, 200)
    assert.equal(full.headers.get('content-type'), 'video/mp4')
    assert.equal(full.headers.get('accept-ranges'), 'bytes')
    assert.equal(Number(full.headers.get('content-length')), size)
    assert.equal((await full.arrayBuffer()).byteLength, size)

    const etag = full.headers.get('etag')
    assert.ok(etag !== null && etag.length > 2)

    // 单段 Range
    const part = await fetch(head, { headers: { range: 'bytes=0-99' } })
    assert.equal(part.status, 206)
    assert.equal(part.headers.get('content-range'), `bytes 0-99/${size}`)
    assert.equal((await part.arrayBuffer()).byteLength, 100)

    // 后缀 Range：最后 64 字节
    const tail = await fetch(head, { headers: { range: 'bytes=-64' } })
    assert.equal(tail.status, 206)
    assert.equal(tail.headers.get('content-range'), `bytes ${size - 64}-${size - 1}/${size}`)
    const tailBytes = Buffer.from(await tail.arrayBuffer())
    assert.deepEqual(tailBytes, readFileSync(VIDEO).subarray(size - 64))

    // 越界
    const bad = await fetch(head, { headers: { range: `bytes=${size + 10}-` } })
    assert.equal(bad.status, 416)
    assert.equal(bad.headers.get('content-range'), `bytes */${size}`)

    // HEAD：有头无体
    const headOnly = await fetch(head, { method: 'HEAD' })
    assert.equal(headOnly.status, 200)
    assert.equal(Number(headOnly.headers.get('content-length')), size)
    assert.equal((await headOnly.arrayBuffer()).byteLength, 0)

    // ETag 命中
    const cached = await fetch(head, { headers: { 'if-none-match': etag } })
    assert.equal(cached.status, 304)
  } finally {
    await server.close()
  }
})

test('素材缺失时路由回 404 而不是挂住', async () => {
  if (hasVideo) {
    // 有素材的机器上，这条只确认文件确实在（404 分支由上面的 skip 逻辑覆盖不到）
    assert.equal(existsSync(VIDEO), true)
    return
  }
  const { routes } = drive()
  const server = await serve(routes)
  try {
    const res = await fetch(`${server.url}/dsh-boot-video/boot.mp4`)
    assert.equal(res.status, 404)
  } finally {
    await server.close()
  }
})

test('导入：上传的用户视频落进 assets/user，能被清单列出、能播、能删', async () => {
  const before = snapshotUserDir()
  const server = await serveWithImportEnabled()
  const payload = uploadBytes()
  const created = []
  try {
    // 一份"文件"当成请求体直接 POST 上去——客户端就是这么发的（裸 body，非 multipart）
    const upload = await fetch(`${server.url}/dsh-boot-video/import`, {
      method: 'POST',
      headers: {
        'content-type': 'video/mp4',
        'x-dshbv-name': encodeURIComponent('我的片子.mp4'),
        'x-dshbv-size': String(payload.length),
      },
      body: payload,
    })
    assert.equal(upload.status, 200, '上传应当成功')
    const result = await upload.json()
    assert.equal(result.ok, true)
    assert.match(result.asset.id, USER_ID, 'id 应当是 u- 开头')
    assert.equal(result.asset.label, '我的片子.mp4', '文件名要走 encodeURIComponent 活着回来')
    assert.equal(result.asset.bytes, payload.length)
    assert.equal(result.url, `/dsh-boot-video/asset/${result.asset.id}.mp4`)
    created.push(result.asset.id)

    const stored = join(USER_DIR, `${result.asset.id}.mp4`)
    assert.equal(existsSync(stored), true, '文件必须落在 assets/user/ 里')
    assert.deepEqual(readFileSync(stored), payload, '落地的字节要和上传的一模一样')

    // 清单
    const listed = await listVia(server)
    assert.ok(
      listed.some((item) => item.id === result.asset.id && item.bytes === payload.length),
      '清单里要有这一段，并且带上大小',
    )

    // 能播：前缀路由把它当素材发出去
    const play = await fetch(`${server.url}${result.url}`)
    assert.equal(play.status, 200)
    assert.equal(play.headers.get('content-type'), 'video/mp4')
    assert.equal(play.headers.get('accept-ranges'), 'bytes')
    assert.equal(Number(play.headers.get('content-length')), payload.length)

    // 越界 id 拿不到东西（前缀路由不能让 `../` 之类的东西溜出去）
    const escape = await fetch(`${server.url}/dsh-boot-video/asset/..%2F..%2Fhdd.mp4`)
    assert.equal(escape.status, 404, '形状不合法的 id 必须 404')

    // 删除：只删插件里那份
    const removed = await fetch(`${server.url}/dsh-boot-video/import/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: result.asset.id }),
    })
    assert.equal(removed.status, 200)
    const afterDelete = await removed.json()
    assert.equal(afterDelete.imported.some((item) => item.id === result.asset.id), false)
    assert.equal(existsSync(stored), false, '文件要被删掉')
    created.length = 0

    // 删不存在的 / 形状不合法的 id：报错但不炸
    const bad = await fetch(`${server.url}/dsh-boot-video/import/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: '../hdd' }),
    })
    assert.equal(bad.status, 400)
    if (hasVideo) assert.equal(existsSync(VIDEO), true, '内置素材绝不能被这种请求碰到')
  } finally {
    for (const id of created) rmSync(join(USER_DIR, `${id}.mp4`), { force: true })
    if (before.length === 0 && existsSync(USER_DIR)) {
      // 这一轮之前是空的，就把空目录也收掉（rmdir 只在真的空时才成功）
      try {
        rmSync(USER_DIR, { recursive: false, force: true })
      } catch {
        /* 还有别的文件就留着 */
      }
    }
    await server.close()
  }
})

test('导入：超过上限的上传被拒（413），且不留下半个文件', async () => {
  const before = snapshotUserDir()
  const server = await serveWithImportEnabled()
  try {
    const response = await fetch(`${server.url}/dsh-boot-video/import`, {
      method: 'POST',
      headers: {
        'content-type': 'video/mp4',
        'x-dshbv-name': 'too-big.mp4',
        // 只报大小、不真的传 512MB：宿主应当在读 body 之前就按 header 拒掉。
        'x-dshbv-size': String(600 * 1024 * 1024),
      },
      body: Buffer.from('x'),
    })
    assert.equal(response.status, 413)
    const payload = await response.json()
    // error 字段现在直接是给用户看的那句话（客户端有些版本只显示它）
    assert.match(payload.error, /512 MB/, '拒绝理由要说人话')
    assert.equal(payload.max, 512 * 1024 * 1024)
    assert.deepEqual(snapshotUserDir(), before, '被拒的上传不该在 assets/user 里留下东西')
  } finally {
    await server.close()
  }
})

test('导入：GET 上传接口报 405，路径导入只在回环可用且要求 token 对得上', async () => {
  const before = snapshotUserDir()
  const server = await serveWithImportEnabled()
  const source = tempDir('dshbv-src-')
  const created = []
  const labelsBefore = existsSync(LABELS_FILE) ? readFileSync(LABELS_FILE, 'utf8') : null
  try {
    const wrongMethod = await fetch(`${server.url}/dsh-boot-video/import`)
    assert.equal(wrongMethod.status, 405)

    const video = join(source.dir, '来自路径的片子.mp4')
    writeFileSync(video, uploadBytes())
    const info = statSync(video)

    // token 对不上 → 拒（客户端换过文件/文件被人改过就会出现这种）
    const stale = await fetch(`${server.url}/dsh-boot-video/import/from-path`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: video, name: '来自路径的片子.mp4', size: info.size, token: 'nope' }),
    })
    assert.equal(stale.status, 400)
    assert.equal((await stale.json()).error, 'stale-selection')

    // token 对得上 → 复制进来（宿主自己读盘，不走浏览器那一趟）
    const token = `${info.size.toString(36)}-${Math.round(info.mtimeMs).toString(36)}`
    const ok = await fetch(`${server.url}/dsh-boot-video/import/from-path`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: video, name: '来自路径的片子.mp4', size: info.size, token: token }),
    })
    assert.equal(ok.status, 200, '回环 + token 正确时应当复制成功')
    const result = await ok.json()
    created.push(result.asset.id)
    assert.equal(result.asset.label, '来自路径的片子.mp4')
    assert.equal(result.asset.bytes, info.size)
    assert.deepEqual(readFileSync(join(USER_DIR, `${result.asset.id}.mp4`)), uploadBytes())

    // 路径不存在 / 不是文件
    const missing = await fetch(`${server.url}/dsh-boot-video/import/from-path`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: join(source.dir, '没有这个文件.mp4'), token: token }),
    })
    assert.equal(missing.status, 404)

    const asDir = await fetch(`${server.url}/dsh-boot-video/import/from-path`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: source.dir, token: token }),
    })
    assert.equal(asDir.status, 400)
    assert.equal((await asDir.json()).error, 'not-a-file')
  } finally {
    for (const id of created) rmSync(join(USER_DIR, `${id}.mp4`), { force: true })
    if (labelsBefore === null) rmSync(LABELS_FILE, { force: true })
    source.cleanup()
    await server.close()
  }
})

test('导入：只收 mp4（非 mp4 一律 415），HEVC 的 mp4 再按编码拒（422），都不留垃圾', { skip: !hasFfmpeg && '这台机器没装 ffmpeg，宿主不做编码校验' }, async () => {
  const before = snapshotUserDir()
  const labelsBefore = existsSync(LABELS_FILE) ? readFileSync(LABELS_FILE, 'utf8') : null
  const server = await serveWithImportEnabled()
  const post = (file, name) =>
    fetch(`${server.url}/dsh-boot-video/import`, {
      method: 'POST',
      headers: {
        'content-type': 'video/mp4',
        'x-dshbv-name': encodeURIComponent(name),
        'x-dshbv-size': String(statSync(file).size),
      },
      body: readFileSync(file),
    })
  try {
    // ① 扩展名这一关：用户 2026-10-09 就是拿 mkv 撞的墙，现在连传都不让传进来
    const mkv = await post(HEVC_MKV_SAMPLE, '欢迎来到月读世界.mkv')
    assert.equal(mkv.status, 415, '不是 mp4 就该在扩展名这一关被拒')
    const mkvBody = await mkv.json()
    assert.equal(mkvBody.code, 'extension-not-allowed', '机器可读的 code 还在')
    assert.match(mkvBody.error, /只收 mp4/, '但 error 字段是给用户看的那句话')

    // ② 编码这一关：装了 mp4 壳但里面是 HEVC，Chromium 解不了，照样拒——
    //    但这次**不删文件**，而是把 id 回给客户端，好让它问用户"要不要自动转码"
    const hevcMp4 = await post(HEVC_SAMPLE, '原版.mp4')
    assert.equal(hevcMp4.status, 422, 'mp4 + HEVC 也要拒，而且理由要说人话')
    const hevcBody = await hevcMp4.json()
    assert.equal(hevcBody.code, 'codec-unsupported')
    assert.match(hevcBody.error, /HEVC|H\.265/, 'error 字段也要是人话')
    assert.equal(hevcBody.salvageable, true, '编码问题是可以靠转码救回来的')
    assert.equal(typeof hevcBody.id, 'string', '要把 id 回给客户端，才能就地转码')
    assert.equal(existsSync(join(USER_DIR, `${hevcBody.id}.mp4`)), true, '可救的那种要把文件留着等转码')

    // ③ 不是视频的文件：没有视频轨，救不了，删掉
    const junk = join(FIXTURE_DIR, 'not-a-video.mp4')
    writeFileSync(junk, '这不是视频')
    const junkResponse = await post(junk, 'not-a-video.mp4')
    assert.equal(junkResponse.status, 422)
    const junkBody = await junkResponse.json()
    assert.match(junkBody.error, /视频轨/)
    assert.equal(junkBody.salvageable, undefined, '没视频轨救不了，不该给转码选项')
    assert.equal(junkBody.id, undefined, '救不了的连 id 都不回')

    // ④ 真 H.264 的 mp4 必须放行（别把能用的也拦了）
    const ok = await post(H264_SAMPLE, 'H264 的片子.mp4')
    assert.equal(ok.status, 200, 'mp4 + H.264 是老实的可播格式，不能误伤')
    const created = (await ok.json()).asset.id
    rmSync(join(USER_DIR, `${created}.mp4`), { force: true })

    // ⑤ 清掉②留下的那份"等着转码"的文件
    rmSync(join(USER_DIR, `${hevcBody.id}.mp4`), { force: true })
    assert.deepEqual(snapshotUserDir(), before, '被拒的上传不该在 assets/user 里留下东西')
  } finally {
    if (labelsBefore === null) rmSync(LABELS_FILE, { force: true })
    await server.close()
  }
})

test('转码：HEVC 的片子上传被拒后，就地转成 H.264 并能播（走真 ffmpeg）', { skip: !hasFfmpeg && '这台机器没装 ffmpeg，转不了' }, async () => {
  const before = snapshotUserDir()
  const labelsBefore = existsSync(LABELS_FILE) ? readFileSync(LABELS_FILE, 'utf8') : null
  const server = await serveWithImportEnabled()
  let createdId = null
  try {
    // 上传一段 HEVC：被拒，但留下 id 等转码
    const uploaded = await fetch(`${server.url}/dsh-boot-video/import`, {
      method: 'POST',
      headers: {
        'content-type': 'video/mp4',
        'x-dshbv-name': encodeURIComponent('待转码的片子.mp4'),
        'x-dshbv-size': String(statSync(HEVC_SAMPLE).size),
      },
      body: readFileSync(HEVC_SAMPLE),
    })
    assert.equal(uploaded.status, 422)
    const rejected = await uploaded.json()
    assert.equal(rejected.salvageable, true)
    createdId = rejected.id

    // 进度接口：这时候还没在转
    const idle = await (await fetch(`${server.url}/dsh-boot-video/import/convert-status`)).json()
    assert.equal(idle.converting, null, '没转的时候状态要是空的')
    assert.equal(typeof idle.ffmpegReady, 'boolean', '要告诉客户端 ffmpeg 就绪没有')

    // 真转一次（样本只有 0.4 秒，几秒内能完）
    const converted = await fetch(`${server.url}/dsh-boot-video/import/convert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: createdId, label: '待转码的片子.mp4' }),
    })
    assert.equal(converted.status, 200, '转码应当成功')
    const payload = await converted.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.asset.id, createdId, '转完还是同一个素材 id')
    assert.equal(typeof payload.converted?.toBytes, 'number', '要回一份转码前后的体积')
    assert.ok(
      payload.imported.some((item) => item.id === createdId),
      '转完要出现在清单里',
    )

    // 转出来的必须真的能播（宿主自己验过一道）
    const play = await fetch(`${server.url}${payload.url}`)
    assert.equal(play.status, 200)
    assert.equal(play.headers.get('content-type'), 'video/mp4')

    // 不存在的 id：干净地报 404
    const ghost = await fetch(`${server.url}/dsh-boot-video/import/convert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'u-zzzz-1', label: 'x.mp4' }),
    })
    assert.equal(ghost.status, 404)
  } finally {
    if (createdId !== null) rmSync(join(USER_DIR, `${createdId}.mp4`), { force: true })
    if (labelsBefore === null) rmSync(LABELS_FILE, { force: true })
    await server.close()
  }
})

test.after(() => {
  if (FIXTURE_DIR !== null) rmSync(FIXTURE_DIR, { recursive: true, force: true })
})

test('导入：自命名只改显示名，磁盘文件名不动；空名字回到原始文件名', async () => {

  const before = snapshotUserDir()
  const server = await serveWithImportEnabled()
  const upload = (name) =>
    fetch(`${server.url}/dsh-boot-video/import`, {
      method: 'POST',
      headers: { 'content-type': 'video/mp4', 'x-dshbv-name': encodeURIComponent(name), 'x-dshbv-size': String(uploadBytes().length) },
      body: uploadBytes(),
    })
  let id = null
  const labelsBefore = existsSync(LABELS_FILE) ? readFileSync(LABELS_FILE, 'utf8') : null
  try {
    const created = await (await upload('原始名字.mp4')).json()
    id = created.asset.id
    assert.equal(created.asset.label, '原始名字.mp4', '没起名字时显示原始文件名')

    // 起名
    const renamed = await fetch(`${server.url}/dsh-boot-video/import/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: id, label: '  我的开场  ' }),
    })
    assert.equal(renamed.status, 200)
    const payload = await renamed.json()
    assert.equal(payload.label, '我的开场', '名字要去掉首尾空白')
    const entry = payload.imported.find((item) => item.id === id)
    assert.equal(entry.label, '我的开场')
    assert.equal(entry.custom, true, '要标出来这是自定义名字')

    // 磁盘上还是 u-*.mp4 —— 改名不动文件名
    assert.equal(existsSync(join(USER_DIR, `${id}.mp4`)), true, '改名绝不能把文件改没了')
    assert.deepEqual(readFileSync(join(USER_DIR, `${id}.mp4`)), uploadBytes(), '内容也不该变')

    // 名字落盘在 labels.json 里
    assert.equal(JSON.parse(readFileSync(LABELS_FILE, 'utf8'))[id], '我的开场')

    // 太长的名字会被截到 40 字
    const long = await fetch(`${server.url}/dsh-boot-video/import/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: id, label: '很'.repeat(80) }),
    })
    assert.equal((await long.json()).label.length, 40)

    // 空名字 = 清掉自定义
    const cleared = await fetch(`${server.url}/dsh-boot-video/import/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: id, label: '' }),
    })
    const clearedPayload = await cleared.json()
    assert.equal(clearedPayload.imported.find((item) => item.id === id).custom, undefined, '清掉后不再有自定义标记')
    assert.equal(JSON.parse(readFileSync(LABELS_FILE, 'utf8'))[id], undefined, '名字表里也不该留着')

    // 对不存在的 id 改名会 404（形状不合法的会被当 400）
    const ghost = await fetch(`${server.url}/dsh-boot-video/import/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'u-zzzz-1', label: 'x' }),
    })
    assert.equal(ghost.status, 404)
  } finally {
    if (id !== null) rmSync(join(USER_DIR, `${id}.mp4`), { force: true })
    if (labelsBefore === null) rmSync(LABELS_FILE, { force: true })
    else writeFileSync(LABELS_FILE, labelsBefore, 'utf8')
    await server.close()
  }
})
