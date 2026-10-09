/**
 * 打**发布包**：只带 HDD 那一段（已获 B 站 UP 主授权），月读世界那段不进包
 * （它是从电影里剪的几秒，没有授权；HDD 那段有）。
 *
 * 为什么不是"写个 .npmignore 就完事"：`package.json` 的 `files` 是**显式白名单**，
 * 会压过 `.npmignore`（实测第一版就是这么翻车的——包里照样有 yuedu.mp4）。
 * 所以这里临时把 `files` 里跟它相关的几行删掉、打完再还原：
 *   ① 备份 package.json → ② 临时改写 files → ③ npm pack → ④ 还原 package.json
 *   → ⑤ 打印包内容，并**核对 yuedu 没混进去**（混进去就删包并以非零码退出）。
 *
 * 用法：node scripts/pack-release.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const MANIFEST = join(ROOT, 'package.json')
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const runNpm = (args) => spawnSync(NPM, args, { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' })

/** 这几个条目要**排除**掉：没授权的那段，以及只对本机有意义的用户素材目录。 */
const EXCLUDE = ['!assets/yuedu.mp4', '!assets/user']

const original = readFileSync(MANIFEST, 'utf8')
const manifest = JSON.parse(original)
// ⚠️ 关键：`files` 里写了目录名（比如 `assets`）就等于把**整个目录**收进去，
// 想排除单个文件只能加 `!` 否定项（删条目是没用的——目录还在，文件照样进包）。
manifest.files = [...(manifest.files ?? []), ...EXCLUDE.filter((entry) => !(manifest.files ?? []).includes(entry))]
const version = String(manifest.version ?? '0.0.0')
const staging = join(ROOT, '.pack-staging')
rmSync(staging, { recursive: true, force: true })
mkdirSync(staging, { recursive: true })

try {
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  // `--pack-destination` 让产物落在**我们指定的目录**里：不用去猜 npm 打印了什么名字。
  const packed = runNpm(['pack', '--pack-destination', staging])
  // npm 跑完立刻把清单还原——后面所有步骤都用不着那份临时清单了。
  writeFileSync(MANIFEST, original, 'utf8')

  const produced = readdirSync(staging).filter((name) => name.endsWith('.tgz'))
  if (packed.status !== 0 || produced.length === 0) {
    console.error('打包失败：')
    console.error(packed.stdout ?? '')
    console.error(packed.stderr ?? '')
    process.exit(packed.status ?? 1)
  }
  const staged = join(staging, produced[0])
  const tarball = `dsh-boot-video-${version}.tgz`
  rmSync(join(ROOT, tarball), { force: true })
  renameSync(staged, join(ROOT, tarball))
  const path = join(ROOT, tarball)

  // ⚠️ `npm pack --dry-run --json` 会报**缓存/旧清单**（实测：明明改了 files，它照样说
  // yuedu.mp4 在里面），所以判定一律以**真包的内容**为准：直接列 tar 里的文件名。
  const listed = spawnSync('tar', ['-tzf', path], { encoding: 'utf8' })
  const entries =
    listed.status === 0
      ? String(listed.stdout ?? '')
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== '' && !line.endsWith('/'))
      : []

  const leaked = entries.filter((entry) => entry.includes('yuedu') || entry.includes('assets/user'))
  console.log(`打好了：${tarball}  ${(statSync(path).size / 1024 / 1024).toFixed(2)} MB`)
  if (entries.length === 0) {
    console.log('（这台机器上没跑成 tar，没法列出包内容——请手工核对）')
  } else {
    console.log(`包内 ${entries.length} 个文件：`)
    for (const entry of entries) console.log(`  ${entry}`)
  }

  if (entries.length === 0 || leaked.length > 0) {
    // 出问题就把包删掉：别让一个混了没授权素材的包留在盘上，免得误发。
    rmSync(path, { force: true })
    console.error('\n⛔ 核对失败：没授权的东西混进包里了（或没法核对），已把包删掉 —— 别发布它。')
    process.exit(2)
  }
  console.log('\n✅ 核对通过：包里只有 HDD 那段素材，没有 yuedu.mp4、也没有本机的用户素材。')
} finally {
  // 不论成功失败都还原清单：工作区里那份永远保持"两段都能用"。
  writeFileSync(MANIFEST, original, 'utf8')
  rmSync(staging, { recursive: true, force: true })
}
