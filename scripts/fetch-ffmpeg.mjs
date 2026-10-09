#!/usr/bin/env node
/**
 * fetch-ffmpeg — 用国内镜像一条命令拿到可用的 ffmpeg。
 *
 * 为什么不直接 `npm i -D @ffmpeg-installer/ffmpeg`：那个包的平台二进制是
 * **optionalDependency**，npm 会把所有平台的包都试着拉一遍（本机实测卡在
 * darwin/linux 那几份上十几分钟），而且偶尔会留下**不完整**的 exe
 * （实测：下到 48 MB、跑不起来；完整的是 61 MB）。
 *
 * 这个脚本只拉当前平台的那一个包，直接解包到 node_modules/@ffmpeg-installer/<平台>/，
 * 并且解包后**真跑一次 `-version`** 才算成功。全程只访问 registry.npmmirror.com。
 *
 * 用法：
 *   node scripts/fetch-ffmpeg.mjs [--version 4.1.0] [--registry https://registry.npmmirror.com]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
const platformDir = `${process.platform}-${process.arch}`
const target = join(ROOT, 'node_modules', '@ffmpeg-installer', platformDir)

const argv = process.argv.slice(2)
let version = 'latest'
let registry = 'https://registry.npmmirror.com'
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--version') version = argv[i + 1]
  else if (argv[i] === '--registry') registry = argv[i + 1]
}

const pkg = `@ffmpeg-installer/${platformDir}`
const metaUrl = `${registry}/${pkg}/${version}`

console.log(`平台包: ${pkg}`)
console.log(`元数据: ${metaUrl}`)

const response = await fetch(metaUrl)
if (!response.ok) {
  console.error(`拉不到元数据（HTTP ${response.status}）——这个平台可能没有对应包`)
  process.exit(2)
}
const meta = await response.json()
const tarball = meta.dist?.tarball
const resolved = meta.version
if (typeof tarball !== 'string') {
  console.error('元数据里没有 tarball 地址')
  process.exit(2)
}

console.log(`版本: ${resolved}`)
console.log(`下载: ${tarball}`)

const tgz = join(tmpdir(), `ffmpeg-${platformDir}-${resolved}.tgz`)
const bytes = Buffer.from(await (await fetch(tarball)).arrayBuffer())
writeFileSync(tgz, bytes)
console.log(`已下载: ${(bytes.length / 1048576).toFixed(2)} MB`)

const staging = join(tmpdir(), `ffmpeg-${platformDir}-${resolved}`)
rmSync(staging, { recursive: true, force: true })
mkdirSync(staging, { recursive: true })
execFileSync('tar', ['-xzf', tgz, '-C', staging, '--strip-components=1'], { stdio: 'inherit' })

const staged = join(staging, exe)
if (!existsSync(staged)) {
  console.error(`解包里没有 ${exe}`)
  process.exit(2)
}

rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
execFileSync('tar', ['-xzf', tgz, '-C', target, '--strip-components=1'], { stdio: 'inherit' })

const installed = join(target, exe)
execFileSync(installed, ['-version'], { stdio: 'inherit' })
console.log(`\n就位: ${installed}（${(statSync(installed).size / 1048576).toFixed(2)} MB）`)
