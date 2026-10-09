window.__ModuleLoader__.load({
	id: "dsh-boot-video",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		//#region src/client.js
		/**
		 * dsh-boot-video — browser half.
		 *
		 * 两个表面：
		 *
		 *   开机视频       由 factory 求值时命令式挂载（不走 slot）——见 mountOverlay()，
		 *                  这是客户端插件能画得最早的时刻：DSH 自己的开机卡片
		 *                  （`[data-dsh-boot]`，"HARNESS / Loading plugins…"）要等
		 *                  客户端模块系统加载完才销毁，走 slot 一定排在它后面。
		 *   设置页         settings.section 里的独立一页（设置侧边栏「开机动画」），
		 *                  见 BootVideoSection——2026-10-09 之前它只是「通用设置」里的
		 *                  一行（settings.general.item），用户要求单开一页、且不再提 550C。
		 *
		 * 覆盖层是 shadow root 里的普通 DOM：视频只有一条 <video>，样式与宿主页面互不干扰。
		 * 首帧由宿主半边（lib/index.js）在文档解析阶段先铺上，这里挂好覆盖层后**同一个任务**
		 * 调 endFirstFrame() 把它撤下——一次绘制完成交接，看不到缝。
		 *
		 * 视频只播一遍（`ended` 就淡出），点画面 / 按 Esc 随时跳过；
		 * 所有出口都走同一个 fade，坏掉的视频也不可能把人锁在黑屏后面。
		 */

		const React = require('react')

		/** 本插件的开关（与 lib/index.js SOURCE_KEY 保持一致）。 */
		const SOURCE_KEY = 'dsh-boot-video:source'
		/** 旧版遗留：只有 `'video'` 才播；其余值一律当「不播」。 */
		const SOURCE_VALUES = ['video', 'off']
		const DEFAULT_SOURCE = 'video'
		/**
		 * 550C 的键——**本插件已与它彻底解耦**，这里只碰最后一次。
		 *
		 * 0.2.0 及更早：开关里有一档「550C 片头」，选「我的视频」时写
		 * `dsh-550c-boot:mode = 'off'`，靠写对方的键实现二选一。
		 * 0.3.0 起（用户 2026-10-09 的要求：「我的插件不要带上 550C 的插件了」）：
		 * 设置页里不再有 550C 这一档，也不再为切换而写别人的键——
		 * 只在启动时做一次**遗留清理**（见 releaseLegacyC550）：把过去留下的 `'off'`
		 * 抹掉，让 550C 回到「键不存在 = 它自己的默认」这个正常状态，之后两边各管各的。
		 */
		const C550_LEGACY_KEY = 'dsh-550c-boot:mode'
		const C550_LEGACY_VALUE = 'off'
		/** 老版本写进本插件开关里的第三档取值：迁移成 'off'（见 releaseLegacyC550）。 */
		const C550_SOURCE_LEGACY_VALUE = '550c'
		/** 与 lib/index.js FIRST_FRAME_GLOBAL 保持一致。 */
		const FIRST_FRAME_GLOBAL = '__dshBootVideoFirstFrame'
		/** 与 lib/index.js VERSION_GLOBAL 保持一致：宿主把自己的版本号挂在这儿，设置页直接读。 */
		const VERSION_GLOBAL = '__dshBootVideoVersion'
		/**
		 * 可选的开屏素材（与 lib/index.js 的 ASSETS 表一一对应）。
		 *
		 * 2026-10-09 起有两段片头都能当开屏，所以做成"可切换"而不是二选一删掉一条：
		 * `hdd` 是插件原配的 HDD 开机动画，`yuedu` 是"欢迎来到月读世界"。
		 */
		const ASSET_KEY = 'dsh-boot-video:asset'
		/**
		 * 清单里所有**可能**存在的素材；实际提供哪几段由宿主决定：
		 * `window.__dshBootVideoAssets`（宿主在 `webserver/index-inject` 里推的）说了算，
		 * 读不到就退化成"全都在"。
		 *
		 * 为什么要按宿主说的来：电影剪的那段（yuedu）没有授权，发布包里宿主根本不提供它，
		 * 客户端就不该把它的按钮画出来、更不该去请求它。
		 */
		const ALL_ASSETS = [
			{ id: 'hdd', label: 'HDD' },
			{ id: 'yuedu', label: '月读世界' },
		]
		const ASSETS = (() => {
			const provided = window.__dshBootVideoAssets
			if (!Array.isArray(provided) || provided.length === 0) return ALL_ASSETS
			const names = provided.filter((id) => typeof id === 'string')
			const filtered = ALL_ASSETS.filter((asset) => names.includes(asset.id))
			return filtered.length === 0 ? ALL_ASSETS : filtered
		})()
		const DEFAULT_ASSET = ASSETS[0].id
		/** 宿主版本与"客户端半边是什么时候加载的"——设置页底部拿它显示体检行。 */
		const CLIENT_LOADED_AT = new Date()
		/** 上一次开机的结果记在这儿（设置页显示一行，用户不用去翻控制台）。 */
		const LAST_BOOT_KEY = 'dsh-boot-video:last-boot'
		/**
		 * 界面里有没有「导入自己的视频」。
		 *
		 * **开着**（用户 2026-10-09 明确「我最重要的导入视频的功能呢」——这是本插件的主功能之一）。
		 * 曾经因为一句「只要 HDD 和月读世界，不需要其他的」把它关过一次，那是我理解错了：
		 * 那句话说的是"**内置**就这两段够用"，不是"把导入砍掉"。
		 *
		 * 宿主那边对应的开关是环境变量 `DSHBV_IMPORT=1`（不设就不注册那四条导入路由）；
		 * 本机/发布都用开着这套，发布包里别人的视频不会跟着走——**用户导入的内容只在用户自己机器上**。
		 */
		const IMPORT_ENABLED = true
		/** 导入素材的 id 形状（与 lib/index.js USER_ID_RE 一致）。 */
		const USER_ASSET_ID_RE = /^u-[a-z0-9]{1,12}-[a-z0-9]{1,6}$/
		const ASSET_ROUTE_PREFIX = '/dsh-boot-video/asset/'

		function assetRoute(id) {
			return ASSET_ROUTE_PREFIX + id + '.mp4'
		}

		function readAsset() {
			try {
				const raw = window.localStorage.getItem(ASSET_KEY)
				if (ASSETS.some((asset) => asset.id === raw)) return raw
				// 关掉导入的版本里，认不出的 id（比如以前导入过的那段）就该退回默认素材——
				// 否则会留一个"选中了一段根本不在界面上的素材"的幽灵状态。
				if (!IMPORT_ENABLED) return DEFAULT_ASSET
				// 开着导入时：id 不在内置表里、但形状对就得认——否则用户选了它，
				// 一到开机又悄悄掉回默认素材（0.4.0 第一版就是这个毛病）。
				return USER_ASSET_ID_RE.test(String(raw)) ? raw : DEFAULT_ASSET
			} catch (error) {
				return DEFAULT_ASSET
			}
		}

		function writeAsset(id) {
			try {
				window.localStorage.setItem(ASSET_KEY, id)
			} catch (error) {
				/* 隐私模式：选择不持久化 */
			}
		}

		/**
		 * 记一次"这次开机结果"，设置页里会显示这一行。
		 *
		 * 为什么要记：出错时用户看不到控制台，只会觉得"黑了/闪了一下"。把它落成一行文字，
		 * 下次打开设置页就知道上次怎么了（2026-10-09 那次排查全靠控制台日志，普通用户没有）。
		 *
		 * @param outcome - 'played' | 'skipped' | 'failed' | 'refused'。
		 * @param detail - 失败时的原因（给用户看的一小段）。
		 */
		function recordLastBoot(outcome, detail) {
			try {
				window.localStorage.setItem(
					LAST_BOOT_KEY,
					JSON.stringify({ outcome, detail: detail ?? '', asset: readAsset(), at: Date.now() }),
				)
			} catch (error) {
				/* 隐私模式：记不上就算了 */
			}
		}

		/** 读上次开机结果；没有或读坏了都返回 null。 */
		function readLastBoot() {
			try {
				const raw = window.localStorage.getItem(LAST_BOOT_KEY)
				if (raw === null) return null
				const parsed = JSON.parse(raw)
				return parsed !== null && typeof parsed === 'object' ? parsed : null
			} catch (error) {
				return null
			}
		}

		/** 把时刻格式化成 `HH:MM:SS`（体检行用）。 */
		function formatClock(date) {
			const pad = (value) => String(value).padStart(2, '0')
			return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
		}

		/** 一次开机结果 → 人话（设置页那一行）。 */
		function describeLastBoot(record) {
			if (record === null || typeof record.outcome !== 'string') return null
			const minutes = Math.max(0, Math.round((Date.now() - Number(record.at ?? 0)) / 60000))
			const since = minutes < 1 ? '刚刚' : minutes < 60 ? `${minutes} 分钟前` : `${Math.round(minutes / 60)} 小时前`
			const where = `${since}${record.asset === undefined ? '' : `，素材 ${record.asset}`}`
			if (record.outcome === 'played') return `上次开机：正常播完（${where}）`
			if (record.outcome === 'skipped') return `上次开机：被你跳过了（${where}）`
			if (record.outcome === 'refused') return `上次开机：播了，但浏览器拒绝了声音、自动静音（${where}）`
			return `上次开机：打不开（${where}）——${record.detail === '' ? '编码或文件有问题' : record.detail}`
		}

		/** 宿主有没有在跑 550C 开机动画（它自己的键是 `dsh-550c-boot:mode`）。 */
		function readC550Mode() {
			try {
				return window.localStorage.getItem('dsh-550c-boot:mode')
			} catch (error) {
				return null
			}
		}

		/**
		 * 把 550C 关掉——**这是本插件唯一一次写别人的键**。
		 *
		 * 为什么还要留：我们和 550C 都是"全屏遮罩自挂 body"，两个都开着就会一起播（视觉上我们的在上层），
		 * 用户只会看到"开机动画怎么变两段了"。0.3.0 起我们不再靠写它的键实现"二选一"，但**开启本插件时
		 * 顺手把它关掉**这条保留：只在它的值不是 `off` 时写一次，用户自己选的 `simple` / `full`
		 * 会被关掉一次（设置页里能看到提示、也能自己改回去）。
		 */
		function writeC550Off() {
			try {
				window.localStorage.setItem('dsh-550c-boot:mode', 'off')
			} catch (error) {
				/* 隐私模式：写不上就算了，最多是两个片头叠着播 */
			}
		}

		/** 导入相关的路由：都用**相对路径**打，网页版打在 3080，桌面版打在 19387。 */
		const UPLOAD_PATH = 'dsh-boot-video/import'
		const LIST_PATH = 'dsh-boot-video/imported.json'
		const DELETE_PATH = 'dsh-boot-video/import/delete'
		const RENAME_PATH = 'dsh-boot-video/import/rename'
		const FROM_PATH = 'dsh-boot-video/import/from-path'
		/** 转码：下 ffmpeg / 真的转 / 查进度。 */
		const FFMPEG_SETUP_PATH = 'dsh-boot-video/ffmpeg/setup'
		const CONVERT_PATH = 'dsh-boot-video/import/convert'
		const CONVERT_STATUS_PATH = 'dsh-boot-video/import/convert-status'
		/** 单文件上限，与 lib/index.js MAX_UPLOAD_BYTES 保持一致。 */
		const MAX_IMPORT_BYTES = 512 * 1024 * 1024
		/** 自定义名字的上限，与 lib/index.js MAX_LABEL_CHARS 保持一致。 */
		const MAX_LABEL_CHARS = 40

		/** 导入清单变了就广播一次：设置页自己写的，自己也得听见。 */
		const IMPORTED_EVENT = 'dsh-boot-video:imported'
		/** 上传进度：`detail = { phase, loaded, total, ratio }`。 */
		const PROGRESS_EVENT = 'dsh-boot-video:import-progress'

		function emitImported() {
			try {
				window.dispatchEvent(new Event(IMPORTED_EVENT))
			} catch (error) {
				/* 老浏览器没有 Event 构造器：那就不广播，设置页重开时会自己拉一次 */
			}
		}

		function emitProgress(detail) {
			try {
				window.dispatchEvent(new CustomEvent(PROGRESS_EVENT, { detail }))
			} catch (error) {
				/* 同上 */
			}
		}

		/**
		 * 拉导入清单。
		 *
		 * @returns `[{ id, bytes, at, label? }]`；拿不到就返回空数组（设置页会显示"还没有"）。
		 */
		async function fetchImported() {
			try {
				const response = await fetch(LIST_PATH, { headers: { accept: 'application/json' } })
				if (!response.ok) return []
				const payload = await response.json()
				return Array.isArray(payload.imported) ? payload.imported : []
			} catch (error) {
				return []
			}
		}

		/** 桌面版的宿主桥：能拿到用户所选文件的**绝对路径**（Electron webUtils.getPathForFile）。 */
		function desktopPaths() {
			const bridge = window.__DSH_HOST_PATHS__
			return bridge !== undefined && bridge !== null && typeof bridge.pathFor === 'function' ? bridge : null
		}

		/** 与 lib/index.js fileToken 保持一致：换过/改过文件就对不上。 */
		function fileToken(size, mtimeMs) {
			return `${size.toString(36)}-${Math.round(mtimeMs).toString(36)}`
		}

		/**
		 * 把用户导入的视频交给宿主（**两段式**，因为要覆盖网页版和桌面版两条载体）。
		 *
		 * ① 桌面版：Electron 能把 File 翻成绝对路径 → 只发一个 JSON，宿主自己复制，
		 *    几百 MB 也不经过渲染进程（快、内存友好）。走不动就往下掉。
		 * ② 通用：把文件本体作为请求体流式 POST 上去（`fetch(url, { body: file })`），
		 *    网页版与桌面版都行；**流式**是关键——不会把整个文件先读进内存。
		 *
		 * @param file - 用户选中的 File。
		 * @returns 宿主记录下来的素材 `{ id, label, bytes, at }`。
		 * @throws 失败时抛出带人类可读信息的 Error。
		 */
		async function importFile(file) {
			const size = Number.isFinite(file.size) ? file.size : 0
			const name = typeof file.name === 'string' ? file.name : ''
			// 只收 mp4（用户 2026-10-09 拍板）：本地就拦，别白传几百 MB 才被拒。
			if (!name.toLowerCase().endsWith('.mp4')) {
				throw new Error(`只收 mp4 文件（当前选的是「${name === '' ? '没名字的文件' : name}」）。用剪映导出时选 mp4 + H.264 再导入`)
			}
			if (size <= 0) throw new Error('这个文件是空的，读不到内容')
			if (size > MAX_IMPORT_BYTES) {
				throw new Error(`文件有 ${formatBytes(size)}，超过 ${formatBytes(MAX_IMPORT_BYTES)} 的上限`)
			}
			emitProgress({ phase: 'reading', loaded: 0, total: size, ratio: 0 })

			const bridge = desktopPaths()
			if (bridge !== null) {
				let path = ''
				try {
					path = String(bridge.pathFor(file) ?? '')
				} catch (error) {
					path = ''
				}
				if (path !== '') {
					emitProgress({ phase: 'copying', loaded: size, total: size, ratio: 1 })
					const copied = await copyByPath(path, file, size)
					if (copied.status === 'ok') return copied.asset
					if (copied.status === 'convertible') {
						// 编码问题：带上"可以转码"的信息抛出去，界面会问用户要不要转。
						const error = new Error(copied.info.reason)
						error.convertible = copied.info
						throw error
					}
				}
			}

			return await uploadFile(file, size)
		}

		/**
		 * 桌面版快路：把路径交给宿主复制。
		 *
		 * @returns `{ status: 'ok', asset }` | `{ status: 'convertible', info }` |
		 *   `{ status: 'retry' }`（这条路不通，调用方回退到上传）。
		 */
		async function copyByPath(path, file, size) {
			let response = null
			let payload = null
			try {
				response = await fetch(FROM_PATH, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						path: path,
						name: file.name,
						size: size,
						token: fileToken(size, file.lastModified),
					}),
				})
				payload = await response.json().catch(() => null)
			} catch (error) {
				return { status: 'retry' }
			}
			if (response.ok && payload !== null && payload.asset !== undefined) {
				return { status: 'ok', asset: payload.asset }
			}
			// 宿主说"这段能靠转码救回来"：别再回退到上传那条白跑一遍，直接把信息交上去。
			if (payload !== null && payload.salvageable === true && typeof payload.id === 'string') {
				return {
					status: 'convertible',
					info: {
						id: payload.id,
						label: file.name,
						reason: typeof payload.message === 'string' ? payload.message : String(payload.error ?? ''),
					},
				}
			}
			return { status: 'retry' }
		}

		/** 通用路：把文件本体 POST 上去，带上传进度。 */
		function uploadFile(file, size) {
			return new Promise((resolve, reject) => {
				const request = new XMLHttpRequest()
				request.open('POST', UPLOAD_PATH)
				request.setRequestHeader('content-type', file.type === '' ? 'application/octet-stream' : file.type)
				request.setRequestHeader('x-dshbv-name', encodeURIComponent(file.name.slice(0, 120)))
				request.setRequestHeader('x-dshbv-size', String(size))
				request.upload.addEventListener('progress', (event) => {
					emitProgress({
						phase: 'uploading',
						loaded: event.loaded,
						total: event.lengthComputable ? event.total : size,
						ratio: event.lengthComputable && event.total > 0 ? event.loaded / event.total : 0,
					})
				})
				request.addEventListener('load', () => {
					let payload = null
					try {
						payload = JSON.parse(request.responseText)
					} catch (error) {
						payload = null
					}
					if (request.status === 200 && payload !== null && payload.asset !== undefined) {
						emitProgress({ phase: 'done', loaded: size, total: size, ratio: 1 })
						resolve(payload.asset)
						return
					}
					reject(uploadFailure(request.status, payload, describeUploadFailure(request.status, payload), file.name))
				})
				request.addEventListener('error', () => reject(new Error('上传中断了，检查一下连接再试')))
				request.addEventListener('abort', () => reject(new Error('上传被取消了')))
				request.send(file)
			})
		}

		/** 宿主的状态码翻成人话；编码这类"能转码救回来"的会把 id 一起带出来。 */
		function describeUploadFailure(status, payload) {
			const code = payload !== null && typeof payload.error === 'string' ? payload.error : ''
			if (status === 413 || code === 'too-large') return '这个文件超过了 512 MB 的上限'
			if (code === 'mkdir-failed') return '插件目录写不进去（检查一下插件文件夹的权限）'
			if (code === 'upload-failed') return '宿主写文件时出错了'
			if (status === 404 || status === 405) return '宿主的导入接口没就绪（插件更新后要重启一次 DSH）'
			return `导入失败（HTTP ${status || '—'}）`
		}

		/**
		 * 把一个失败响应翻成 Error。
		 *
		 * 要是宿主说"这段能靠转码救回来"（`salvageable` + 给了 id），就把那段信息挂在
		 * `error.convertible` 上——界面据此问用户"要不要自动转码"。
		 *
		 * @param status - HTTP 状态码。
		 * @param payload - 宿主回的 JSON（可能是 null）。
		 * @param fallback - 没有可用文案时的兜底话术。
		 * @param context - 用来补 id / 名字（上传时是 File，按路径复制时是那段 JSON）。
		 * @returns Error。
		 */
		function uploadFailure(status, payload, fallback, context) {
			// 宿主现在把"给用户看的那句话"直接放在 error 字段里；message 是旧字段，一起兼容。
			const human =
				payload !== null && typeof payload.error === 'string' && !/^[a-z-]+$/.test(payload.error)
					? payload.error
					: payload !== null && typeof payload.message === 'string' && payload.message !== ''
						? payload.message
						: fallback
			const error = new Error(human)
			if (payload !== null && payload.salvageable === true && typeof payload.id === 'string') {
				error.convertible = {
					id: payload.id,
					label: typeof payload.label === 'string' && payload.label !== '' ? payload.label : context,
					reason: typeof payload.message === 'string' ? payload.message : human,
				}
			}
			return error
		}

		/** 删除一个导入的素材（只删插件里的那份，原片不动）。 */
		async function deleteImported(id) {
			const response = await fetch(DELETE_PATH, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ id: id }),
			})
			if (!response.ok) throw new Error(`删除失败（HTTP ${response.status}）`)
			const payload = await response.json()
			return Array.isArray(payload.imported) ? payload.imported : []
		}

		/**
		 * 给一段导入的素材起个自己的名字（空名字 = 清掉自定义，回到原始文件名）。
		 *
		 * 只改显示名：磁盘上还是 `u-*.mp4`，所以改名永远不会动到正在用的素材。
		 *
		 * @param id - 素材 id。
		 * @param label - 新名字（会被宿主截到 40 字）。
		 * @returns 刷新后的清单。
		 */
		async function renameImported(id, label) {
			const response = await fetch(RENAME_PATH, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ id: id, label: label }),
			})
			if (!response.ok) throw new Error(`改名失败（HTTP ${response.status}）`)
			const payload = await response.json()
			return Array.isArray(payload.imported) ? payload.imported : []
		}

		//#region 自动转码（HEVC / mkv 这类浏览器解不了的，交给宿主用 ffmpeg 转）

		/**
		 * 确保宿主那边有 ffmpeg 可用（没有就让它从**国内镜像**下一份，约 28MB）。
		 *
		 * @returns 真正的宿主响应。
		 * @throws 下载失败时抛出带人话的 Error。
		 */
		async function setupFfmpeg() {
			let response = null
			try {
				response = await fetch(FFMPEG_SETUP_PATH, { method: 'POST' })
			} catch (error) {
				throw new Error('连不上宿主，转码需要宿主那一半在跑')
			}
			const payload = await response.json().catch(() => null)
			if (response.ok !== true || payload === null || payload.ok !== true) {
				throw new Error((payload !== null && typeof payload.error === 'string' && payload.error) || `准备 ffmpeg 失败（HTTP ${response.status}）`)
			}
			return payload
		}

		/**
		 * 在后台轮询转码进度（用来画进度条）。
		 *
		 * @param onChange - 每次拿到状态时回调 `{ phase, loaded, total, ratio }` 或 null（没在转）。
		 * @returns 停止轮询的函数。
		 */
		function watchConvertProgress(onChange) {
			let alive = true
			let timer = null
			const tick = async () => {
				if (!alive) return
				try {
					const response = await fetch(CONVERT_STATUS_PATH, { headers: { accept: 'application/json' } })
					if (response.ok) {
						const payload = await response.json()
						if (payload.fetching !== null && payload.fetching !== undefined) onChange(payload.fetching)
						else onChange(payload.converting ?? null)
					}
				} catch (error) {
					/* 轮询失败无所谓，下一轮再试 */
				}
				if (alive) timer = window.setTimeout(tick, 1000)
			}
			timer = window.setTimeout(tick, 300)
			return () => {
				alive = false
				if (timer !== null) window.clearTimeout(timer)
			}
		}

		/**
		 * 让宿主把一段"浏览器解不了"的视频转成 H.264，并收进清单。
		 *
		 * 流程：先确保 ffmpeg 就绪（没有就下载，进度通过 `onPhase` 报给你）→ 再转。
		 *
		 * @param id - 上传被拒时宿主回的素材 id。
		 * @param label - 名字。
		 * @param onPhase - `(phaseText) => void`，用来更新界面上的那句话。
		 * @returns 宿主记下来的素材 `{ id, label, bytes, at }`。
		 */
		async function convertImported(id, label, onPhase) {
			const status = await fetch(CONVERT_STATUS_PATH, { headers: { accept: 'application/json' } })
				.then((response) => (response.ok ? response.json() : null))
				.catch(() => null)
			if (status === null || status.ffmpegReady !== true) {
				onPhase('正在下载 ffmpeg（约 28MB，走国内镜像，第一次装才需要）…')
				await setupFfmpeg()
			}
			onPhase('正在转码…')
			const response = await fetch(CONVERT_PATH, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ id: id, label: label }),
			})
			const payload = await response.json().catch(() => null)
			if (response.ok !== true || payload === null || payload.ok !== true) {
				throw new Error((payload !== null && typeof payload.error === 'string' && payload.error) || `转码失败（HTTP ${response.status}）`)
			}
			return payload.asset
		}

		/** 放弃一段"等转码"的文件：让宿主把它从素材目录删掉。 */
		async function dropPending(id) {
			try {
				await fetch(DELETE_PATH, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ id: id }),
				})
			} catch (error) {
				/* 删不掉也不影响界面（它不在清单里） */
			}
		}

		//#endregion

		/** 字节数 → 人能读的大小。 */
		function formatBytes(bytes) {
			const value = Number(bytes)
			if (!Number.isFinite(value) || value <= 0) return '0 B'
			const units = ['B', 'KB', 'MB', 'GB']
			let index = 0
			let size = value
			while (size >= 1024 && index < units.length - 1) {
				size /= 1024
				index += 1
			}
			return `${index === 0 ? String(Math.round(size)) : size.toFixed(size >= 10 ? 1 : 2)} ${units[index]}`
		}

		/** 文件名的显示形式：太长就中间截断。 */
		function shortLabel(label, max) {
			const text = typeof label === 'string' && label !== '' ? label : '导入的视频'
			return text.length <= max ? text : `${text.slice(0, max - 1)}…`
		}
		/**
		 * 「等界面加载完再播」的延时。
		 *
		 * 为什么需要：片头一动，解码 + 磁盘读 + 音频就开始跟 DSH 自己的客户端模块抢 CPU / IO，
		 * 低配机器上会看到"界面出来得慢一点"。把它往后挪一小会儿，界面就先出来了；
		 * 代价是片头晚 0.6 秒开始（**等待期间如果视频已经就绪，就提前开始**，所以多数情况下察觉不到）。
		 *
		 * 只在**应用启动**这一条路上生效（模块求值时的自动播放）；设置页点「播放一遍」永远立刻播。
		 * 想让片头一出即播就把它设成 0（`localStorage['dsh-boot-video:start-delay'] = '0'`）。
		 */
		const START_DELAY_KEY = 'dsh-boot-video:start-delay'
		const DEFAULT_START_DELAY_MS = 600
		/** 淡出时长，必须与 HOST_CSS 的 transition 一致。 */
		const FADE_MS = 480
		/** 视频在这个时间内就绪的话，就提前开始，别干等。 */
		const READY_EARLY_MS = 2000

		/** 读启动延时（毫秒，0 = 不等）。 */
		function readStartDelay() {
			try {
				const raw = window.localStorage.getItem(START_DELAY_KEY)
				if (raw === null) return DEFAULT_START_DELAY_MS
				const value = Number(raw)
				return Number.isFinite(value) && value >= 0 ? Math.min(value, 10000) : DEFAULT_START_DELAY_MS
			} catch (error) {
				return DEFAULT_START_DELAY_MS
			}
		}
		/** 拿不到 duration 时的兜底上限；`window.__dshBootVideoWatchdogMs` 可覆盖（测试用）。 */
		const FALLBACK_MAX_MS =
			Number(window.__dshBootVideoWatchdogMs) > 0 ? Number(window.__dshBootVideoWatchdogMs) : 60000
		/**
		 * 视频打不开时那块提示卡片：自己停留多久，以及"多久还没拿到元数据"就判定打不开。
		 *
		 * 用户 2026-10-09 导了一段 HEVC 的 mkv 进桌面版，看到的只有黑屏一闪——
		 * 加载失败会立刻走 `error`，覆盖层直接撤掉，用户根本不知道发生了什么。
		 * 现在失败改成**留一块看得懂的卡片**再自己退场。
		 */
		const BROKEN_CARD_MS = 6000
		const METADATA_TIMEOUT_MS = 12000
		const SETTINGS_STYLE_ID = 'dsh-boot-video-settings-style'
		/**
		 * 画面填充固定为「完整」——`object-fit: contain`，写在 HOST_CSS 里。
		 *
		 * 2026-10-04 曾经做过「铺满 / 完整」两档，用户看完两档之后说「铺满可以删掉的」：
		 * 16:9 的窗口播一条 2.35:1 的片子，铺满要裁掉左右各约 12%，那是画面少了一块，
		 * 不是更饱满。而片源自带的黑边已经在 `scripts/make-asset.mjs` 里裁掉了，
		 * 剩下的黑边只是窗口比例与片子比例的差，留着就好。
		 */

		/** 当前唯一的活动覆盖层；设置页的预览按钮和启动触发共用它。 */
		let liveOverlay = null
		/** 设置页样式只插一次。 */
		let settingsStyleReady = false

		function readSource() {
			try {
				const raw = window.localStorage.getItem(SOURCE_KEY)
				return SOURCE_VALUES.indexOf(raw) >= 0 ? raw : DEFAULT_SOURCE
			} catch (error) {
				return DEFAULT_SOURCE
			}
		}

		function writeSource(value) {
			try {
				window.localStorage.setItem(SOURCE_KEY, value)
			} catch (error) {
				/* 隐私模式：选择不持久化而已 */
			}
		}

		/**
		 * 开关的落点：只写自己的键，不碰任何别的插件。
		 *
		 * @param value - 'video' | 'off'
		 */
		function applySource(value) {
			writeSource(SOURCE_VALUES.indexOf(value) >= 0 ? value : DEFAULT_SOURCE)
		}

		/**
		 * 遗留标记清理：把 0.2.0 及更早留下的两样东西归位。
		 *
		 * 1) `dsh-550c-boot:mode = 'off'`——那是老版本"选我的视频就顺手关掉 550C"写的。
		 *    550C 在**键不存在**时才走自己的默认值，留着它用户就永远看不到 550C，
		 *    还会以为是它坏了。清掉之后两个插件互不干扰：各读各的键，同时开着就各播各的
		 *    （我们的首帧 z-index 更高，视觉上在上面）。只在值确属"我们写的 'off'"时删，
		 *    用户自己在 550C 设置里选的其它值一律不碰。
		 *
		 * 2) 自己的 `dsh-boot-video:source = '550c'`——老版本的三态开关才有这一档，
		 *    新版本认的值只有 'video' / 'off'，留着会被当成"没设过"而回到默认的视频。
		 *    用户当初选 550C 就是不想看我们这段动画，所以迁移成 'off'（"先不播"），
		 *    要播在设置页点一下即可。
		 */
		function releaseLegacyC550() {
			try {
				const storage = window.localStorage
				if (storage.getItem(C550_LEGACY_KEY) === C550_LEGACY_VALUE) storage.removeItem(C550_LEGACY_KEY)
				if (storage.getItem(SOURCE_KEY) === C550_SOURCE_LEGACY_VALUE) storage.setItem(SOURCE_KEY, 'off')
			} catch (error) {
				/* 读不到/删不掉就算了：那只是别的插件的键，以及一次可选的迁移 */
			}
		}

		/**
		 * 认不出的素材：把它从"上次选的"里清掉，换回默认素材，**并在同一次开机里重播**。
		 *
		 * 为什么需要：用户选过一段导入的视频、之后那段被删了（或者被别的工具清掉了），
		 * 浏览器还记着它 → 每次开机都去请求一个不存在的文件 → 一块"打不开"的卡片。
		 * 用户不该为这种事买单：认识不到就自己退回去播默认那段（2026-10-09 用户就撞上了）。
		 *
		 * @returns 是否真的换了（换了调用方就重播一遍）。
		 */
		function dropBrokenAsset() {
			let current = null
			try {
				current = window.localStorage.getItem(ASSET_KEY)
			} catch (error) {
				return false
			}
			if (current === null || current === DEFAULT_ASSET) return false
			writeAsset(DEFAULT_ASSET)
			return true
		}

		/** 覆盖层的几何与过渡；内容只有一条 <video>。 */
		const HOST_CSS = `
		:host{position:fixed;inset:0;display:block;z-index:2147483100;background:#000;transition:opacity ${FADE_MS}ms cubic-bezier(.4,0,.2,1)}
		:host(.dshbv-out){opacity:0;pointer-events:none}
		video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000;display:block}
		.dshbv-hint{position:absolute;right:22px;bottom:20px;z-index:3;padding:6px 14px;border-radius:999px;background:rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.22);color:rgba(255,255,255,.85);font:500 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;letter-spacing:.02em;pointer-events:none;transition:opacity 300ms ease}
		:host(.dshbv-out) .dshbv-hint{opacity:0}
		.dshbv-sound{position:absolute;left:22px;bottom:20px;z-index:4;padding:8px 16px;border-radius:999px;background:rgba(0,0,0,.58);border:1px solid rgba(255,255,255,.3);color:#fff;font:500 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;cursor:pointer;transition:background 160ms ease,border-color 160ms ease}
		.dshbv-sound:hover{background:rgba(0,0,0,.78);border-color:rgba(255,255,255,.55)}
		.dshbv-sound[hidden]{display:none}
		.dshbv-break{position:absolute;inset:0;z-index:5;display:flex;align-items:center;justify-content:center;background:#000;padding:24px}
		.dshbv-break-card{max-width:520px;display:flex;flex-direction:column;gap:10px;padding:22px 24px;border-radius:16px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.18);font:400 13px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:rgba(255,255,255,.88)}
		.dshbv-break-title{font-size:15px;font-weight:600;color:#fff}
		.dshbv-break-btn{align-self:flex-start;margin-top:4px;appearance:none;border:1px solid rgba(255,255,255,.35);background:transparent;color:#fff;font:500 13px/1.5 inherit;padding:8px 18px;border-radius:999px;cursor:pointer}
		.dshbv-break-btn:hover{background:rgba(255,255,255,.14)}
		`

		/**
		 * 撤下宿主半边铺的首帧。
		 *
		 * 宿主那条注入的脚本在同一时刻画着同一块底色，所以这里在挂完覆盖层的**同一个任务**里
		 * 调用它：两帧互换发生在一次绘制之内，没有缝、没有闪、不留痕。
		 * 如果客户端半边从没出现，那条脚本自己的 12 秒上限会兜住，不会留黑屏。
		 */
		function endFirstFrame() {
			const handle = window[FIRST_FRAME_GLOBAL]
			if (handle === undefined || handle === null) return
			try {
				delete window[FIRST_FRAME_GLOBAL]
				handle.end()
			} catch (error) {
				console.error('[dsh-boot-video] first frame refused to end', error)
			}
		}

		/**
		 * 挂载开机视频覆盖层。
		 *
		 * 与 550C 一样，**不走 slot**：slot 要等整个客户端模块系统加载完才渲染，
		 * 那时 DSH 的开机卡片早就画完了。apply() 在加载阶段跑，这是客户端能画的最早时刻；
		 * 再早的那几百毫秒由宿主半边的首帧顶着。
		 *
		 * @param force - 忽略开关强制播放（预览按钮用）。
		 * @returns 活动的覆盖层记录，或什么都没挂时返回 null。
		 */
		function mountOverlay(force, startDelay) {
			if (liveOverlay !== null) return liveOverlay
			if (!force && readSource() !== 'video') return null

			if (document.body === null) {
				// factory 可能在文档还在解析时被求值：覆盖层需要一个 body 才挂得上。
				document.addEventListener('DOMContentLoaded', () => mountOverlay(force), { once: true })
				return null
			}

			const host = document.createElement('div')
			host.className = 'dshbv-host'
			// 用本插件自己的标记名：`data-dsh-boot-splash` 是 dsh-web 家族的私有契约
			// （它会给这个选择器加样式，还会在开机盾牌里把节点**移除**），借名字会丢点击。
			host.dataset.dshbvBoot = ''
			host.setAttribute('aria-hidden', 'true')
			document.body.appendChild(host)

			const shadow = host.attachShadow({ mode: 'open' })
			const style = document.createElement('style')
			style.textContent = HOST_CSS
			shadow.appendChild(style)

			const video = document.createElement('video')
			video.src = assetRoute(readAsset())
			video.autoplay = true
			// **先试带声音**：桌面版（Electron）默认允许未静音自动播放，开机就是画面+声音一起出来；
			// 浏览器（网页版）会拦，由 tryPlay 自动降级成静音并亮出「打开声音」。
			// 一份代码，两种载体各得其所——不需要为两边维护两份插件。
			video.muted = false
			video.playsInline = true
			video.setAttribute('playsinline', '')
			video.setAttribute('preload', 'auto')
			shadow.appendChild(video)

			const hint = document.createElement('div')
			hint.className = 'dshbv-hint'
			hint.textContent = '点击画面跳过'
			shadow.appendChild(hint)

			// 只有"未静音被浏览器拦、已降级成静音"时才亮出来（见 tryPlay）。
			// 点了只开声音、不跳过。
			const sound = document.createElement('button')
			sound.type = 'button'
			sound.className = 'dshbv-sound'
			sound.textContent = '🔊 打开声音'
			sound.hidden = true
			shadow.appendChild(sound)

			const record = {
				host: host,
				video: video,
				finished: false,
				fadeTimer: null,
				cardTimer: null,
				watchdog: null,
				dispose: null,
			}

			const skip = () => {
				finish()
			}
			const onKey = (event) => {
				if (event.key === 'Escape') skip()
			}

			const dispose = () => {
				if (record.fadeTimer !== null) window.clearTimeout(record.fadeTimer)
				if (record.cardTimer !== null) window.clearTimeout(record.cardTimer)
				if (record.watchdog !== null) window.clearTimeout(record.watchdog)
				host.removeEventListener('click', skip)
				window.removeEventListener('keydown', onKey, true)
				document.removeEventListener('visibilitychange', onVisibility)
				sound.removeEventListener('click', onSound)
				try {
					video.pause()
					video.removeAttribute('src')
					video.load()
				} catch (error) {
					/* 卸载时出错不影响界面 */
				}
				host.remove()
				if (liveOverlay === record) liveOverlay = null
			}

			const finish = (reason) => {
				// 视频正常播完/被点掉：先立守卫（免得 ended、click、watchdog 三路一起收场），再退场。
				if (record.finished) return
				record.finished = true
				if (record.watchdog !== null) {
					window.clearTimeout(record.watchdog)
					record.watchdog = null
				}
				recordLastBoot(reason === 'ended' ? 'played' : 'skipped')
				dismiss()
			}

			/**
			 * 淡出并收掉覆盖层。
			 *
			 * **这条出口不看 `finished`**——出了错的路径（那块说明卡片）已经把 `finished`
			 * 立起来了，如果它再走 `finish()` 就会被自己的守卫挡住、永远卡在屏上。
			 * 2026-10-09 就是这么把用户的桌面版锁死的：卡片上的"跳过"和 6 秒自动退场都是空转，
			 * 他连主界面都进不去。`fadeTimer` 这个"已经在退场了"的守卫对两个方向都够用。
			 */
			const dismiss = () => {
				if (record.fadeTimer !== null) return
				// 卡片那条"自己停留 6 秒"的计时器与淡出用的是**两个字段**：
				// 早先两者共用一个 fadeTimer，结果卡片一画就把"正在退场"的标记占住，
				// dismiss() 自己把自己挡回去 → 卡片永远挂在屏上（2026-10-09 的锁屏事故）。
				if (record.cardTimer !== null) {
					window.clearTimeout(record.cardTimer)
					record.cardTimer = null
				}
				host.classList.add('dshbv-out')
				record.fadeTimer = window.setTimeout(dispose, FADE_MS + 40)
			}

			const onSound = (event) => {
				event.stopPropagation()
				video.muted = false
				sound.hidden = true
				const played = video.play()
				if (played !== undefined && typeof played.catch === 'function') played.catch(() => {})
			}

			/**
			 * 视频打不开（编码不支持、文件损坏、路径没了）时，**留一块看得懂的卡片**再退场。
			 *
			 * 为什么要有：加载失败原来直接走 finish()，用户只看到"黑屏一闪"，什么都不知道
			 * （用户 2026-10-09 导了一段 HEVC 的 mkv，就是这个现象）。卡片说明白"这段视频打不开、
			 * 换一段或转成 H.264"，停几秒自己淡出，点一下按钮立刻走。
			 */
			let brokenShown = false
			const showPlaybackError = (message) => {
				if (record.finished) return
				record.finished = true
				if (record.watchdog !== null) {
					window.clearTimeout(record.watchdog)
					record.watchdog = null
				}
				if (brokenShown) return
				brokenShown = true
				recordLastBoot('failed', String(message).slice(0, 60))
				if (hint.parentNode !== null && hint.parentNode !== undefined) hint.remove()
				sound.remove()
				const card = document.createElement('div')
				card.className = 'dshbv-break-card'
				const title = document.createElement('div')
				title.className = 'dshbv-break-title'
				title.textContent = '这段开机视频打不开'
				const body = document.createElement('div')
				body.textContent = message
				const skipButton = document.createElement('button')
				skipButton.type = 'button'
				skipButton.className = 'dshbv-break-btn'
				skipButton.textContent = '先跳过（去设置里换个素材）'
				skipButton.addEventListener('click', (event) => {
					event.stopPropagation()
					dismiss()
				})
				card.appendChild(title)
				card.appendChild(body)
				card.appendChild(skipButton)
				const layer = document.createElement('div')
				layer.className = 'dshbv-break'
				layer.appendChild(card)
				shadow.appendChild(layer)
				record.cardTimer = window.setTimeout(dismiss, BROKEN_CARD_MS)
			}

			record.dispose = dispose
			record.finish = finish
			record.showPlaybackError = showPlaybackError

			/**
			 * 绝对兜底：视频坏了、解码卡住、duration 读到 NaN，都不能把人锁在覆盖层后面。
			 *
			 * 但**页面一次都没露过面**不算超时：Chromium 在后台根本不会给媒体加载数据，
			 * 这时候判死等于"用户切回前台只看到空白"。所以那种情况重新计时。
			 */
			const armWatchdog = (ms, label) => {
				if (record.watchdog !== null) window.clearTimeout(record.watchdog)
				record.watchdog = window.setTimeout(() => {
					if (record.finished) return
					if (document.visibilityState !== 'visible') {
						armWatchdog(FALLBACK_MAX_MS, label)
						return
					}
					// 一次元数据都没拿到 = 这段视频根本没起来：给一块看得懂的卡片，
					// 而不是黑屏一闪。
					if (video.readyState === 0) {
						console.error(`[dsh-boot-video] watchdog fired (${label}); no media at all`)
						showPlaybackError(
							'这段视频没能加载起来：可能文件不在了、或者浏览器解不了它的编码（HEVC / H.265 就不行）。去「设置 → 开机动画」里换一段。',
						)
						return
					}
					console.error(`[dsh-boot-video] watchdog fired (${label}); dismissing the splash`)
					finish('watchdog')
				}, ms)
			}
			armWatchdog(Math.min(FALLBACK_MAX_MS, METADATA_TIMEOUT_MS), 'no metadata')

			video.addEventListener('ended', () => finish('ended'))
			video.addEventListener('error', () => {
				console.error('[dsh-boot-video] video failed to load', video.error)
				// 4 = MEDIA_ERR_SRC_NOT_SUPPORTED（编码/封装不支持）：这种要说明白，不能只是黑屏一闪。
				// 其余（网络抖动、被中断）保持原来的"直接淡出"，它不该在开机时吓人。
				const code = video.error === null || video.error === undefined ? 0 : Number(video.error.code)
				if (code === 4) {
					// 先看是不是"选中的那段没了/坏了"：是的话悄悄换回默认素材并重播，
					// 用户不该为一段已经不在的文件反复看到报错卡片。
					if (dropBrokenAsset()) {
						console.error('[dsh-boot-video] 选中的素材加载不了，已退回默认素材')
						finish('asset-missing')
						replay()
						return
					}
					showPlaybackError(
						'浏览器解不了它的编码（HEVC / H.265 这类就不行），或者文件不在、封装不受支持。去「设置 → 开机动画」里换一段。',
					)
					return
				}
				finish('error')
			})
			video.addEventListener('loadedmetadata', () => {
				const ms =
					Number.isFinite(video.duration) && video.duration > 0 ? video.duration * 1000 + 5000 : FALLBACK_MAX_MS
				armWatchdog(ms, 'past the clip end')
			})

			host.addEventListener('click', skip)
			sound.addEventListener('click', onSound)
			window.addEventListener('keydown', onKey, true)

			/**
			 * 起播：**带声音优先**，被拒才降级静音，并且不要把"起播被拒"当成"播不了"。
			 *
			 * 桌面版（Electron，`autoplayPolicy: no-user-gesture-required`）能直接放声，
			 * 所以那边开机就是视频 + 声音；网页版浏览器会拒，于是这里自动降级静音、
			 * 亮出「打开声音」按钮，让用户想看时自己开。
			 *
			 * 另有一条踩过的坑：窗口在后台、页面被 Chromium 节流时，连 muted 的 play() 都会
			 * reject。旧写法一被拒就 finish()，结果覆盖层自己撤掉、开机卡片露出来，
			 * 桌面版还判定这个 entry 没激活、弹「应用无法启动」。所以这里只重试、不收场。
			 */
			let playAttempts = 0
			const tryPlay = () => {
				playAttempts += 1
				const played = video.play()
				if (played === undefined || typeof played.catch !== 'function') return
				played.catch((error) => {
					const name =
						error !== null && typeof error === 'object' && 'name' in error
							? String(error.name)
							: String(error)
					// AbortError 是我们自己中断的（暂停/换源/移除），不是"播不了"。
					if (name === 'AbortError' || record.finished) return
					console.error(`[dsh-boot-video] autoplay refused (${name}), attempt ${playAttempts}`, error)
					if (!video.muted) {
						// 未静音被拦（网页版的常态）：降级静音立刻再来一次，并记一笔"声音被拒"。
						video.muted = true
						sound.hidden = false
						recordLastBoot('refused')
						window.setTimeout(() => {
							if (!record.finished) tryPlay()
						}, 200)
						return
					}
					// 连静音都被拒：隔一会儿重试；重试用尽也不收场，留着覆盖层交给 watchdog，
					// 总比露出一块黑屏或把 boot 拖垮强。
					if (playAttempts < 6) {
						window.setTimeout(() => {
							if (!record.finished) tryPlay()
						}, 800)
					}
				})
			}

			/**
			 * 页面从后台回到前台时，把被 Chromium 推迟掉的媒体加载重新踢起来。
			 *
			 * 实测（桌面版，Electron 44）：页面不可见时 `<video>` **一个字节都不会加载**——
			 * `play()` 成功返回、`paused` 也是 false，但 `readyState` 永远是 0、
			 * `networkState` 是 IDLE，而且窗口回到前台**不会自动恢复**，用户只会看到一块黑屏。
			 * 所以回到前台时重新挂一次源（仅在还没拿到任何数据时），再播一次。
			 */
			const onVisibility = () => {
				if (record.finished || document.visibilityState !== 'visible') return
				if (video.readyState === 0) {
					try {
						video.load()
					} catch (error) {
						/* 重新挂源失败也不该把界面拖垮 */
					}
				}
				playAttempts = 0
				// 无条件再播一次：隐藏期间那次 play() 在真机上会"成功返回却没有一个字节的数据"，
				// 只看 paused 会漏掉这种情况（它此时已经是 false 了）。
				tryPlay()
			}
			document.addEventListener('visibilitychange', onVisibility)

			/**
			 * 起播：**等一小会儿再开**（只在应用启动这条路上），好让 DSH 自己的界面先把模块加载完。
			 *
			 * 为什么要延：4K 片头一动，解码 + 磁盘读 + 音频就开始跟客户端模块抢资源，低配机器上
			 * 界面会显得出来得慢。挪 0.6 秒（默认）之后界面先上屏，片头随后接上。
			 * ✅ 不牺牲体验的关键：**等待期间视频一旦就绪就提前开始**（`loadedmetadata` 或
			 *    `readyState >= 3`），所以多数机器上就是"加载本身花掉的那点时间"，感觉不到额外等待。
			 */
			const startPlayback = () => {
				const delay = startDelay ?? 0
				if (delay <= 0) {
					tryPlay()
					return
				}
				const startedAt = Date.now()
				const begin = () => {
					if (record.finished || record.started === true) return
					record.started = true
					tryPlay()
				}
				record.startTimer = window.setTimeout(begin, delay)
				video.addEventListener('loadedmetadata', () => {
					if (Date.now() - startedAt < READY_EARLY_MS) begin()
				})
				// 兜底：能读到数据就早点开始
				const earlyCheck = window.setInterval(() => {
					if (record.finished || record.started === true) {
						window.clearInterval(earlyCheck)
						return
					}
					if (video.readyState >= 3) {
						window.clearInterval(earlyCheck)
						begin()
					}
				}, 100)
			}

			startPlayback()
			liveOverlay = record
			// 挂上覆盖层这个任务的最后一句：宿主首帧与本 shadow root 在同一次绘制里互换。
			endFirstFrame()
			return record
		}

		/**
		 * 用当前设置重播一遍：设置页的「播放一遍」按钮、换素材、把开关拨回「我的视频」
		 * 都走这里。
		 *
		 * 先把在播的那个收掉再挂新的：`mountOverlay` 是"一次只挂一个"的语义
		 * （liveOverlay 非空就直接返回旧的那个），不先收掉的话换素材只会什么都不发生。
		 */
		function replay() {
			if (liveOverlay !== null) {
				liveOverlay.dispose()
				liveOverlay = null
			}
			return mountOverlay(true)
		}

		/**
		 * 设置页的样式。
		 *
		 * 只用主题里**确实存在**的 token（0.2.0 那版写的 `--dsw-alias-text-primary` /
		 * `--dsw-alias-fill-tertiary` 在本主题里根本没有定义，于是每次都掉进兜底色——
		 * 这正是用户截图里"素材按钮看起来没选中"的原因）。可用的那几个是：
		 * `--dsw-alias-label-primary/secondary/tertiary/caption`、
		 * `--dsw-alias-border-l1/l2/l3`、`--dsw-alias-interactive-bg-hover`。
		 * 底色一律用 `color-mix(in srgb, currentColor …)`——没有硬编码颜色，深浅主题都跟着走。
		 */
		const SETTINGS_CSS = `
		.dshbv-set{display:flex;flex-direction:column;gap:10px;max-width:760px;padding:2px 0 8px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.6}
		.dshbv-set-head{display:flex;flex-direction:column;gap:4px}
		.dshbv-set-title{font-size:16px;font-weight:600;line-height:1.4}
		.dshbv-set-summary{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}
		.dshbv-set-card{display:flex;flex-direction:column;gap:10px;padding:12px;border:1px solid var(--dsw-alias-border-l3);border-radius:10px;background:color-mix(in srgb,currentColor 3%,transparent)}
		.dshbv-set-row{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
		.dshbv-set-row-stack{flex-direction:column;align-items:stretch;gap:8px}
		.dshbv-set-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-top:2px}
		.dshbv-set-label{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500}
		.dshbv-set-hint{color:var(--dsw-alias-label-caption,#8a8a8a);font-size:12px;line-height:1.6;margin-top:2px}
		.dshbv-set-off{margin-top:6px;color:var(--dsw-alias-label-tertiary,#9a9a9a);font-size:12px;line-height:1.6}
		.dshbv-set-replay{margin-top:6px}
		.dshbv-set-ctrl{display:flex;align-items:center;gap:8px;flex:none;flex-wrap:wrap}
		.dshbv-set-ctrl-inner{flex:none;gap:8px;flex-wrap:nowrap;margin-left:2px}
		.dshbv-set-seg{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:9px;background:color-mix(in srgb,currentColor 7%,transparent);flex-wrap:wrap}
		.dshbv-set-seg button{appearance:none;display:inline-flex;align-items:center;gap:6px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;font-weight:500;line-height:1.5;padding:5px 11px;border-radius:7px;cursor:pointer;transition:background 140ms ease,color 140ms ease}
		.dshbv-set-seg button:hover{background:var(--dsw-alias-interactive-bg-hover)}
		.dshbv-set-seg button.on{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 20%,transparent);color:var(--dsw-alias-label-primary);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 45%,transparent)}
		.dshbv-set-seg button.on::before{content:'✓';font-size:11px;font-weight:700;opacity:.9}
		.dshbv-set-asset button{min-width:72px;max-width:180px;justify-content:center}
		.dshbv-set-asset{max-width:100%}
		/* 素材按钮里的文字用 CSS 截断：名字再长也不会把右边的按钮挤出容器
		   （用户 2026-10-09 的截图就是「播放一遍」被挤出面板）。 */
		.dshbv-set-seg-label{display:inline-block;max-width:132px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom}
		.dshbv-set-asset button>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
		.dshbv-set-chipwrap{display:inline-flex;align-items:center;gap:2px}
		.dshbv-set-x{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-caption,#8a8a8a);cursor:pointer;font-size:13px;line-height:1;width:22px;height:22px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;padding:0;transition:background 140ms ease,color 140ms ease}
		.dshbv-set-x:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 16%,transparent);color:var(--dsw-alias-state-error-primary,#e5484d)}
		.dshbv-set-feedback:empty{display:none}
		.dshbv-set-convert{margin-top:8px;padding:10px 12px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 40%,transparent);border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 10%,transparent);display:flex;flex-direction:column;gap:6px}
		.dshbv-set-convert-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
		.dshbv-set-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;font-weight:500;line-height:1.5;padding:5px 14px;border-radius:8px;cursor:pointer;transition:background 140ms ease,border-color 140ms ease}
		.dshbv-set-btn:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l1)}
		.dshbv-set-importbtn{display:inline-flex;align-items:center}
		.dshbv-set-file{display:none}
		.dshbv-set-imported{display:flex;flex-direction:column;gap:6px;margin-top:2px}
		.dshbv-set-user{display:flex;flex-direction:column;gap:4px}
		.dshbv-set-user-item{display:flex;align-items:center;gap:8px}
		.dshbv-set-user-item>button:first-child{appearance:none;flex:1;min-width:0;display:flex;align-items:baseline;justify-content:space-between;gap:10px;background:transparent;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:12px;line-height:1.5;padding:6px 10px;text-align:left;transition:background 140ms ease,border-color 140ms ease,color 140ms ease}
		.dshbv-set-user-item>button:first-child:hover{background:var(--dsw-alias-interactive-bg-hover)}
		.dshbv-set-user-item>button.on{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 14%,transparent);color:var(--dsw-alias-label-primary)}
		.dshbv-set-user-item>button.on .dshbv-set-user-name::before{content:'✓ ';font-weight:700}
		.dshbv-set-user-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
		.dshbv-set-user-size{flex:none;color:var(--dsw-alias-label-caption,#8a8a8a);font-variant-numeric:tabular-nums}
		.dshbv-set-input{flex:1;min-width:0;appearance:none;background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1.5;padding:6px 10px}
		.dshbv-set-input:focus{outline:none;border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 55%,transparent)}
		.dshbv-set-del{appearance:none;flex:none;border:1px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-caption,#8a8a8a);cursor:pointer;font:inherit;font-size:12px;line-height:1.5;padding:5px 10px;border-radius:8px;transition:color 140ms ease,border-color 140ms ease}
		.dshbv-set-del:hover{color:var(--dsw-alias-state-error-primary,#e5484d);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 45%,transparent)}
		.dshbv-set-progress{margin-top:6px;height:4px;border-radius:2px;background:color-mix(in srgb,currentColor 10%,transparent);overflow:hidden}
		.dshbv-set-bar{height:100%;border-radius:2px;background:var(--dsw-alias-brand-primary,#4d6bfe);transition:width 160ms linear}
		.dshbv-set-ok{margin-top:6px;color:var(--dsw-alias-state-success-primary,#22c55e);font-size:12px;line-height:1.6}
		.dshbv-set-err{margin-top:6px;color:var(--dsw-alias-state-error-primary,#e5484d);font-size:12px;line-height:1.6}
		.dshbv-set-foot{color:var(--dsw-alias-label-caption,#8a8a8a);font-size:12px;line-height:1.7}
		.dshbv-set-diag{margin-top:6px;padding-top:6px;border-top:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.2));display:flex;flex-direction:column;gap:2px}
		.dshbv-set-warn{color:var(--dsw-alias-state-warn-primary,#f59e0b)}
		.dshbv-modal{position:fixed;inset:0;z-index:2147483200;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);padding:24px}
		.dshbv-modal-card{width:100%;max-width:420px;display:flex;flex-direction:column;gap:10px;padding:18px 20px;border-radius:14px;background:var(--dsw-alias-bg-layer-2,#1c1c1e);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));box-shadow:0 12px 32px rgba(0,0,0,.35);color:var(--dsw-alias-label-primary,#eee)}
		.dshbv-modal-title{font-size:14px;font-weight:600}
		.dshbv-modal-hint{color:var(--dsw-alias-label-caption,#8a8a8a);font-size:12px;line-height:1.6}
		.dshbv-modal-input{width:100%;box-sizing:border-box;font-size:13px;padding:8px 10px}
		.dshbv-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:2px}
		.dshbv-btn-primary{border-color:transparent;background:var(--dsw-alias-brand-primary,#4d6bfe);color:#fff}
		.dshbv-btn-primary:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 82%,#000)}
		.dshbv-set-foot code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px}
		.dshbv-set-foot b{font-weight:600;color:var(--dsw-alias-label-secondary)}
		`

		function ensureSettingsStyle() {
			if (settingsStyleReady) return
			settingsStyleReady = true
			if (document.getElementById(SETTINGS_STYLE_ID) !== null) return
			const style = document.createElement('style')
			style.id = SETTINGS_STYLE_ID
			style.textContent = SETTINGS_CSS
			document.head.appendChild(style)
		}

		/** 选中项的勾。按钮的文字用 span 包住，勾由 CSS `::before` 画，不与文字一起被重排。 */
		function segLabel(text) {
			return React.createElement('span', { className: 'dshbv-set-seg-label' }, text)
		}

		/** 每一行的「标签 + 提示」两段文字。 */
		function rowText(title, hint) {
			return React.createElement(
				'div',
				{ className: 'dshbv-set-text' },
				React.createElement('div', { className: 'dshbv-set-label' }, title),
				hint === undefined || hint === null ? null : React.createElement('div', { className: 'dshbv-set-hint' }, hint),
			)
		}

		/**
		 * 设置侧边栏里的「开机动画」页。
		 *
		 * 2026-10-09 用户的要求：「我想把在黄色框区域内单开一个用来修改回框里面的内容，
		 * （但注意，我的插件不要带上550C的插件了）」——所以这一页只放本插件的东西：
		 * 开关（我的视频 / 不播放）+ 素材（HDD / 月读世界 + 导入的）+ 预览，不再有 550C 那一档，
		 * 也不再为切换去写别人的键（遗留的 `'off'` 由 releaseLegacyC550 清掉）。
		 *
		 * 0.4.0 加「导入自己的视频」：内置的两段照旧塞在包里，导入的落在插件的
		 * `assets/user/` 里，两边在这一页里平起平坐——谁都能选、能预览、能删。
		 */
		function BootVideoSection() {
			const [source, setSource] = React.useState(readSource)
			const [asset, setAsset] = React.useState(readAsset)
			const [imported, setImported] = React.useState([])
			const [job, setJob] = React.useState(null)
			/** 一段"浏览器解不了、但可以转码救回来"的暂存文件（非 null 时界面会问要不要转）。 */
			const [pending, setPending] = React.useState(null)
			/** 正在改名的素材 id（null = 没在改），以及输入框里的草稿。 */
			const [renaming, setRenaming] = React.useState(null)
			const [draft, setDraft] = React.useState('')
			/** 550C 的当前档位（用来在设置页提示"它也在放"）。 */
			const [c550, setC550] = React.useState(readC550Mode)
			/** 藏起来的 file input：按钮点它才能打开系统文件选择器。 */
			const fileInput = React.useRef(null)

			const refreshImported = () => {
				let alive = true
				fetchImported().then((items) => {
					if (alive) setImported(items)
				})
				return () => {
					alive = false
				}
			}

			React.useEffect(() => {
				ensureSettingsStyle()
				// 界面不带导入时，没理由去打那几条接口（宿主的导入路由也是关的）。
				if (!IMPORT_ENABLED) return undefined
				const stop = refreshImported()
				const onImported = () => {
					refreshImported()
				}
				const onProgress = (event) => {
					const detail = event !== undefined && event !== null ? event.detail : null
					if (detail !== null && detail !== undefined) setJob({ phase: detail.phase, loaded: detail.loaded, total: detail.total, ratio: detail.ratio })
				}
				window.addEventListener(IMPORTED_EVENT, onImported)
				window.addEventListener(PROGRESS_EVENT, onProgress)
				return () => {
					stop()
					window.removeEventListener(IMPORTED_EVENT, onImported)
					window.removeEventListener(PROGRESS_EVENT, onProgress)
				}
			}, [])

			/** 换开关：选了「我的视频」立刻重播一遍（用户不用为了看效果重启）。 */
			const chooseSource = (value) => {
				setSource(value)
				applySource(value)
				// 自己开机时"顺手把 550C 写成 off"（只写一次、认准是我们写的值），
				// 再刷新一下那条提示，免得设置页说着"还在放"、实际已经关了。
				if (value === 'video') {
					if (readC550Mode() !== 'off') writeC550Off()
					setC550(readC550Mode())
					replay()
					return
				}
				if (liveOverlay !== null) liveOverlay.dispose()
			}

			/**
			 * 换素材：立刻用新的重播一遍，否则用户得重启才知道换没换。
			 *
			 * 开关在「不播放」时就只记下来、不播——用户明确说了不播，不该被一次点击推翻；
			 * 等他拨回「我的视频」，选中的这段自然上场。
			 */
			const chooseAsset = (id) => {
				setAsset(id)
				writeAsset(id)
				if (readSource() === 'video') replay()
			}

			/** 用户挑了一段自己的视频：交给宿主存进插件的 `assets/user/`。 */
			const startImport = async (file) => {
				if (file === null || file === undefined) return
				setPending(null)
				setJob({ phase: 'reading', loaded: 0, total: file.size, ratio: 0 })
				try {
					const saved = await importFile(file)
					await acceptImported(saved)
				} catch (error) {
					const info = error !== null && error !== undefined ? error.convertible : undefined
					if (info !== null && info !== undefined) {
						// 编码问题：**留着文件**，问用户要不要自动转码（转码由宿主用 ffmpeg 做）
						setPending({ id: info.id, label: info.label })
						setJob({ phase: 'refused', message: info.reason })
					} else {
						setJob({
							phase: 'error',
							message: error !== null && error !== undefined && error.message !== undefined ? String(error.message) : String(error),
						})
					}
				}
			}

			/** 导入成功之后统一收尾：刷新清单、选上它、播一遍、弹起名窗。 */
			const acceptImported = async (saved) => {
				emitImported()
				setJob({ phase: 'done', loaded: saved.bytes, total: saved.bytes, ratio: 1, label: saved.label })
				chooseAsset(saved.id)
				setRenaming(saved.id)
				setDraft(shortLabel(saved.label, MAX_LABEL_CHARS))
			}

			/** 点「自动转换」：下 ffmpeg（如果还没有）+ 转码 + 转完自动导入。 */
			const acceptConvert = async () => {
				if (pending === null) return
				const target = pending
				setPending(null)
				setJob({ phase: 'converting', loaded: 0, total: 0, ratio: 0 })
				const stop = watchConvertProgress((progress) => {
					if (progress === null) return
					setJob({
						phase: progress.phase === 'fetching' ? 'fetching' : 'converting',
						loaded: progress.loaded ?? 0,
						total: progress.total ?? 0,
						ratio: progress.ratio ?? (progress.total > 0 ? Math.min(1, (progress.loaded ?? 0) / progress.total) : 0),
					})
				})
				try {
					const saved = await convertImported(target.id, target.label, (text) => {
						setJob({ phase: 'converting', loaded: 0, total: 0, ratio: 0, note: text })
					})
					stop()
					await acceptImported(saved)
				} catch (error) {
					stop()
					// 转码失败：让宿主把那段暂存文件删掉，别在磁盘上留个没用的
					await dropPending(target.id)
					setJob({
						phase: 'error',
						message: error !== null && error !== undefined && error.message !== undefined ? String(error.message) : String(error),
					})
				}
			}

			/** 点「不用了」：把暂存的那段删掉。 */
			const declineConvert = async () => {
				if (pending === null) return
				const target = pending
				setPending(null)
				setJob({ phase: 'deleted' })
				await dropPending(target.id)
			}

			/**
			 * 文件选择器变化时把 File 捞出来，然后立刻把 input 清空（同一个文件能再选一次）。
			 *
			 * @param event - change 事件。
			 */
			const onFileChosen = (event) => {
				const input = event !== null && event !== undefined ? event.target : null
				const file =
					input !== null && input !== undefined && input.files !== null && input.files !== undefined
						? input.files[0]
						: null
				if (input !== null && input !== undefined) input.value = ''
				if (file !== null && file !== undefined) startImport(file)
			}

			/** 点按钮时去戳那个藏起来的 file input。 */
			const openFileDialog = () => {
				if (fileInput.current !== null && fileInput.current !== undefined) fileInput.current.click()
			}

			/** 删掉一段导入的视频：只删插件里的那份。删的正好是当前选中的，就退回默认素材。 */
			const removeImported = async (id) => {
				try {
					const rest = await deleteImported(id)
					setImported(rest)
					if (readAsset() === id) chooseAsset(DEFAULT_ASSET)
					if (renaming === id) setRenaming(null)
					setJob({ phase: 'deleted' })
				} catch (error) {
					setJob({
						phase: 'error',
						message: error !== null && error !== undefined && error.message !== undefined ? String(error.message) : String(error),
					})
				}
			}

			/** 进入改名状态：把当前显示名填进草稿。 */
			const startRename = (item) => {
				setRenaming(item.id)
				setDraft(shortLabel(item.label, MAX_LABEL_CHARS))
			}

			/** 关掉弹窗、什么都不改（原名保留）。 */
			const cancelRename = () => {
				setRenaming(null)
			}

			/** 提交改名。空名字 = 清掉自定义、回到原始文件名（宿主那边就是这么定的）。 */
			const commitRename = async () => {
				if (renaming === null) return
				try {
					const rest = await renameImported(renaming, draft.trim().slice(0, MAX_LABEL_CHARS))
					setImported(rest)
					setRenaming(null)
					setJob({ phase: 'renamed' })
				} catch (error) {
					setJob({
						phase: 'error',
						message: error !== null && error !== undefined && error.message !== undefined ? String(error.message) : String(error),
					})
					setRenaming(null)
				}
			}

			const version = typeof window[VERSION_GLOBAL] === 'string' ? window[VERSION_GLOBAL] : null
			const playing = source === 'video'
			const sourceOptions = [
				{ value: 'video', label: '我的视频' },
				{ value: 'off', label: '不播放' },
			]

			const toggleRow = React.createElement(
				'div',
				{ className: 'dshbv-set-row', key: 'toggle' },
				rowText(
					'启动时播放',
					playing
						? '启动客户端时全屏播放，播完淡出进界面；点画面或按 Esc 跳过。'
						: '启动时不播放动画，直接进界面。',
				),
				React.createElement(
					'div',
					{ className: 'dshbv-set-ctrl' },
					React.createElement(
						'div',
						{ className: 'dshbv-set-seg' },
						sourceOptions.map((option) =>
							React.createElement(
								'button',
								{
									key: option.value,
									type: 'button',
									className: source === option.value ? 'on' : '',
									'aria-pressed': source === option.value ? 'true' : 'false',
									onClick: () => chooseSource(option.value),
								},
								segLabel(option.label),
							),
						),
					),
				),
			)

			const offNote = playing
				? null
				: React.createElement(
						'div',
						{ className: 'dshbv-set-off', key: 'offnote' },
						React.createElement('code', null, `localStorage['${SOURCE_KEY}'] = 'off'`),
						'　—— 大版本更新、界面出问题时，在浏览器控制台删掉这个键即可恢复播放。',
					)

			/**
			 * 导入按钮：真按钮去戳那个藏起来的 file input（label 转发点击在 Electron 里不生效）。
			 *
			 * 它跟"▶ 播放一遍"一起挂在「片头素材」那一行的右边（用户 2026-10-09 点名要的位置），
			 * 导入进来的片子会直接出现在左边的素材选择条里——不用再去下面找。
			 */
			const importButton = React.createElement(
				'label',
				{ className: 'dshbv-set-btn dshbv-set-importbtn', key: 'importbtn', title: '只收 mp4（H.264），上限 512 MB' },
				'⬆ 导入视频',
				React.createElement('input', {
					type: 'file',
					accept: '.mp4,video/mp4',
					className: 'dshbv-set-file',
					ref: fileInput,
					onChange: onFileChosen,
				}),
			)

			const busy =
				job !== null &&
				job !== undefined &&
				(job.phase === 'reading' ||
					job.phase === 'copying' ||
					job.phase === 'uploading' ||
					job.phase === 'fetching' ||
					job.phase === 'converting')

			/** 删除一段导入的素材：小「×」，只删插件里那份。 */
			const removeChip = (item) =>
				React.createElement(
					'button',
					{
						key: `del-${item.id}`,
						type: 'button',
						className: 'dshbv-set-x',
						title: '从插件里删掉这段视频（你的原片不动）',
						onClick: () => removeImported(item.id),
					},
					'×',
				)

			/** 把一段导入的素材做成素材按钮 + 小「×」。名字只取前 10 个字，免得把素材带撑宽。 */
			const chip = (item) =>
				React.createElement(
					'div',
					{ key: item.id, className: 'dshbv-set-chipwrap' },
					React.createElement(
						'button',
						{
							type: 'button',
							className: asset === item.id ? 'on' : '',
							'aria-pressed': asset === item.id ? 'true' : 'false',
							title: item.label,
							onClick: () => chooseAsset(item.id),
						},
						segLabel(shortLabel(item.label, 8)),
					),
					removeChip(item),
				)

			/** 内置素材：跟导入的混在同一条按钮带里，就是一个多一根「×」的差别。 */
			const builtinChip = (item) =>
				React.createElement(
					'button',
					{
						key: item.id,
						type: 'button',
						className: asset === item.id ? 'on' : '',
						'aria-pressed': asset === item.id ? 'true' : 'false',
						onClick: () => chooseAsset(item.id),
					},
					segLabel(item.label),
				)

			/** 「片头素材」：素材带独占一行（可换行），操作按钮右对齐另起一行——面板只有 800px 宽，
			 *  三样东西挤一行会把「播放一遍」挤出屏幕（用户 2026-10-09 截图反馈）。 */
			const assetRow = React.createElement(
				'div',
				{ className: 'dshbv-set-row dshbv-set-row-stack', key: 'asset' },
				rowText(
					'片头素材',
					IMPORT_ENABLED
						? imported.length === 0
							? '插件自带两段；点「⬆ 导入视频」可以放一段自己的 mp4（只收 H.264，HEVC 会自动转），导入后就在这条里。'
							: `自带两段 + 你自己导入的 ${imported.length} 段；点一下就换成那段，并马上重播一遍。`
						: '插件自带的两段片子；点一下就换成那段，并马上重播一遍。画面按完整比例居中显示，不裁切。',
				),
				React.createElement(
					'div',
					{ className: 'dshbv-set-seg dshbv-set-asset' },
					IMPORT_ENABLED ? [...ASSETS.map(builtinChip), ...imported.map(chip)] : ASSETS.map(builtinChip),
				),
				React.createElement(
					'div',
					{ className: 'dshbv-set-actions' },
					IMPORT_ENABLED ? importButton : null,
					React.createElement(
						'button',
						{ type: 'button', className: 'dshbv-set-btn', onClick: () => replay(), title: '不重启就看看效果' },
						'▶ 播放一遍',
					),
				),
			)

			/**
			 * 自命名弹窗（用户 2026-10-09 的要求：「每导入一个视频，随即就主动弹窗让其自命名」）。
			 *
			 * 导入完当场弹出来，草稿预填原始文件名；回车/「就这么定」保存，Esc/「先用原名」跳过（保留原名）。
			 * 里面每个节点都 `stopPropagation`，免得点到覆盖层的"跳过"上去。
			 */
			const renameModal =
				renaming === null
					? null
					: React.createElement(
							'div',
							{
								className: 'dshbv-modal',
								onClick: (event) => {
									if (event !== null && event !== undefined && typeof event.stopPropagation === 'function') event.stopPropagation()
								},
							},
							React.createElement(
								'div',
								{ className: 'dshbv-modal-card' },
								React.createElement('div', { className: 'dshbv-modal-title' }, '给它起个名字'),
								React.createElement(
									'div',
									{ className: 'dshbv-modal-hint' },
									'以后在设置页里就认这个名字（磁盘上的文件名不动，原片也不动）。留空就先用原始文件名。',
								),
								React.createElement('input', {
									type: 'text',
									className: 'dshbv-set-input dshbv-modal-input',
									value: draft,
									maxLength: MAX_LABEL_CHARS,
									placeholder: '比如：月读世界开场',
									autoFocus: true,
									onChange: (event) => setDraft(event.target.value),
									onKeyDown: (event) => {
										if (event.key === 'Enter') commitRename()
										if (event.key === 'Escape') cancelRename()
									},
								}),
								React.createElement(
									'div',
									{ className: 'dshbv-modal-actions' },
									React.createElement(
										'button',
										{ type: 'button', className: 'dshbv-set-btn', onClick: () => cancelRename() },
										'先用原名',
									),
									React.createElement(
										'button',
										{ type: 'button', className: 'dshbv-set-btn dshbv-btn-primary', onClick: () => commitRename() },
										'就这么定',
									),
								),
							),
						)

			const progress = busy
				? React.createElement(
						'div',
						{ className: 'dshbv-set-progress', key: 'progress' },
						React.createElement('div', {
							className: 'dshbv-set-bar',
							style: { width: `${Math.round((job.ratio ?? 0) * 100)}%` },
						}),
					)
				: null

			const message =
				job !== null && job !== undefined && job.phase === 'done'
					? React.createElement(
							'div',
							{ className: 'dshbv-set-ok', key: 'done' },
							`导入完成：${job.label ?? '视频'}（${formatBytes(job.total)}），已经选上并播了一遍。`,
						)
					: job !== null && job !== undefined && job.phase === 'renamed'
						? React.createElement('div', { className: 'dshbv-set-ok', key: 'renamed' }, '名字改好了。')
						: job !== null && job !== undefined && job.phase === 'deleted'
							? React.createElement('div', { className: 'dshbv-set-hint', key: 'deleted' }, '已经删掉插件里那一份。')
							: job !== null && job !== undefined && job.phase === 'refused'
								? React.createElement(
										'div',
										{ className: 'dshbv-set-err', key: 'refused' },
										`这段视频暂时不能当片头：${job.message ?? ''}`,
									)
								: job !== null && job !== undefined && job.phase === 'error'
									? React.createElement('div', { className: 'dshbv-set-err', key: 'err' }, `出错了：${job.message}`)
									: job !== null && job !== undefined && (job.phase === 'fetching' || job.phase === 'converting')
										? React.createElement(
												'div',
												{ className: 'dshbv-set-hint', key: 'conv' },
												job.note ??
													(job.phase === 'fetching'
														? `正在下载 ffmpeg ${formatBytes(job.loaded)} / ${formatBytes(job.total)}`
														: job.total > 0
															? `正在转码 ${Math.round((job.ratio ?? 0) * 100)}%（${Math.round(job.loaded)}s / ${Math.round(job.total)}s）`
															: '正在转码…'),
											)
										: job !== null && job !== undefined && job.phase === 'uploading'
											? React.createElement(
													'div',
													{ className: 'dshbv-set-hint', key: 'up' },
													`上传中 ${formatBytes(job.loaded)} / ${formatBytes(job.total)}`,
												)
											: busy
												? React.createElement('div', { className: 'dshbv-set-hint', key: 'read' }, '正在读取文件…')
												: null

			/** 「我导入的视频」：每条只做两件事——改名、删除（选中交给上面那条素材带）。 */
			const importedList =
				imported.length === 0
					? React.createElement(
							'div',
							{ className: 'dshbv-set-hint', key: 'none' },
							'还没有导入过视频——内置的 HDD / 月读世界就是现成的两段；导入的片子会自动出现在上面的素材带里。',
						)
					: React.createElement(
							'div',
							{ className: 'dshbv-set-user', key: 'list' },
							imported.map((item) => {
								return React.createElement(
									'div',
									{ className: 'dshbv-set-user-item', key: item.id },
									React.createElement(
										'div',
										{ className: 'dshbv-set-user-name dshbv-set-user-static' },
										`${shortLabel(item.label, 34)}　·　${formatBytes(item.bytes)}`,
									),
									React.createElement(
										'button',
										{
											type: 'button',
											className: 'dshbv-set-del',
											title: '给它起个自己的名字（只改显示名，磁盘文件名不动）',
											onClick: () => startRename(item),
										},
										'改名',
									),
									React.createElement(
										'button',
										{
											type: 'button',
											className: 'dshbv-set-del',
											title: '从插件里删掉这段视频（你的原片不动）',
											onClick: () => removeImported(item.id),
										},
										'删除',
									),
								)
							}),
						)

			/** 导入相关的回馈（进度条 / 结果提示）都挂在这一行下面，不另起一张卡片。 */
			const importFeedback = React.createElement(
				'div',
				{ className: 'dshbv-set-feedback', key: 'feedback' },
				/** 编码不支持时的岔路：问一句要不要自动转码（宿主用 ffmpeg 转）。 */
				pending === null
					? null
					: React.createElement(
							'div',
							{ className: 'dshbv-set-convert' },
							React.createElement(
								'div',
								{ className: 'dshbv-set-convert-title' },
								`这段视频浏览器解不了它的编码（${shortLabel(pending.label, 24)}）`,
							),
							React.createElement(
								'div',
								{ className: 'dshbv-set-hint' },
								'可以让插件自动转成能播的格式（H.264 mp4）。第一次用需要下载一个 ffmpeg 工具（约 28MB，走国内镜像，不翻墙），之后就不用再下了。',
							),
							React.createElement(
								'div',
								{ className: 'dshbv-modal-actions' },
								React.createElement(
									'button',
									{ type: 'button', className: 'dshbv-set-del', onClick: () => declineConvert() },
									'不用了',
								),
								React.createElement(
									'button',
									{ type: 'button', className: 'dshbv-set-btn dshbv-btn-primary', onClick: () => acceptConvert() },
									'自动转换',
								),
							),
						),
				progress,
				message,
			)

			const importsCard = React.createElement(
				'div',
				{ className: 'dshbv-set-card' },
				importFeedback,
				React.createElement(
					'div',
					{ className: 'dshbv-set-imported' },
					React.createElement(
						'div',
						{ className: 'dshbv-set-label' },
						imported.length === 0 ? '我导入的视频' : `我导入的视频（${imported.length}）`,
					),
					importedList,
					React.createElement(
						'div',
						{ className: 'dshbv-set-hint' },
						'存在插件的 ',
						React.createElement('code', null, 'dsh-boot-video/assets/user/'),
						' 里；只收 mp4（H.264）、上限 512 MB；「删除」只删插件里这一份，你自己的原片不受影响。',
					),
				),
			)

			const foot = React.createElement(
				'div',
				{ className: 'dshbv-set-foot', key: 'foot' },
				playing
					? '开关为「我的视频」时，启动时会先铺一层纯黑首帧抢在 DSH 开机卡片之前，视频就绪后再交接。'
					: '当前不播放：DSH 启动时由它自己的界面直接上屏。',
				React.createElement(
					'div',
					null,
					'声音：桌面版直接带声播放；网页版被浏览器拦下未静音自动播放时自动降级静音，并亮出「打开声音」按钮。',
				),
				version === null
					? React.createElement('div', null, '插件版本：读不到（宿主那一半可能没起来）。')
					: React.createElement('div', null, `插件版本 ${version}（宿主那一半）。`),
				/** 体检行：让用户一眼看清"现在跑的是哪一版、上次开机到底怎么了"。 */
				React.createElement(
					'div',
					{ className: 'dshbv-set-diag' },
					describeLastBoot(readLastBoot()) === null
						? React.createElement('div', null, '上次开机：还没有记录（下一次启动会写上）。')
						: React.createElement('div', null, describeLastBoot(readLastBoot())),
					React.createElement(
						'div',
						null,
						`客户端半边加载于 ${formatClock(CLIENT_LOADED_AT)}（刷新页面或重开 DSH 都会更新；重开了还是旧样子，就说明页面没真正重新加载）。`,
					),
					c550 === null || c550 === 'off'
						? null
						: React.createElement(
								'div',
								{ className: 'dshbv-set-warn' },
								`检测到 550C 开机动画也开着（它的档位是「${c550 === 'full' ? '完整' : '简易'}」）。`,
								'两个片头都是全屏遮罩、同时开会叠着播（本插件在上层）；点一次上面的「我的视频」会自动把它关掉。',
							),
				),
			)

			return React.createElement(
				'div',
				{ className: 'dshbv-set' },
				React.createElement(
					'div',
					{ className: 'dshbv-set-head' },
					React.createElement('div', { className: 'dshbv-set-title' }, '开机动画'),
					React.createElement(
						'p',
						{ className: 'dshbv-set-summary' },
						'给 DSH 换一段视频开机片头：你想放的那段 mp4、什么时候放、放哪一段，都在这一页。',
					),
				),
				React.createElement(
					'div',
					{ className: 'dshbv-set-card' },
					toggleRow,
					offNote,
					assetRow,
				),
				IMPORT_ENABLED ? importsCard : null,
				foot,
				renameModal,
			)
		}

		/**
		 * 挂上两个表面。
		 *
		 * 设置这一页走 `settings.section`——设置侧边栏里独立的一格（先例：本机 meow-memory
		 * 的「喵记忆」页）。`label` 给侧边栏当导航文字，整个页面的内容由组件自己画；
		 * 面板只负责滚动和留白（`.VOzbGW_options{padding:0 24px 24px}`），所以这里不再自己套
		 * 一层 padding。
		 *
		 * slot 名写成字面量是刻意的：注入器的预检静态读取 register() 调用，跟不动常量。
		 * order 25：紧挨着「预设 / 表情」（都排在 25）那一片，属于"装了什么就多一格"的位置。
		 */
		function apply(ctx) {
			ctx.slots.inject('settings.section', () =>
				ctx.slots.register(
					{ name: 'settings.section', id: 'boot-video', order: 25, label: '开机动画' },
					BootVideoSection,
				),
			)

			// 覆盖层不是 slot 贡献（原因见 mountOverlay），所以用 effect 管生命周期：
			// 插件被停用时要能把它从屏上带走。
			ctx.effect(
				() => () => {
					if (liveOverlay !== null) liveOverlay.dispose()
				},
				'dsh-boot-video: splash teardown',
			)
		}

		/**
		 * 在**模块求值**时就把覆盖层挂上。
		 *
		 * 这是客户端插件能画的最早时刻：factory 在模块系统还在排空时就跑了，
		 * 那时 cordis 还没解析完服务图、apply() 也还没被调用。这里早到的每一毫秒，
		 * 都是从 DSH 自己那张 "Loading plugins…" 卡片手里抢来的。
		 * 生命周期仍然归插件管：apply() 注册了 teardown effect。
		 */
		releaseLegacyC550()
		// 只在**应用启动**这条路上给延时：让 DSH 自己的界面先把模块加载完；
		// 设置页的「播放一遍」「换素材」走 mountOverlay(true)，永远立刻播。
		const bootSplash = mountOverlay(false, readStartDelay())

		exports.name = 'boot-video'
		exports.inject = ['slots']
		exports.apply = apply
		/**
		 * 测试把手：几个不依赖 React 的纯函数（读/写设置、重播）。
		 *
		 * 浏览器 bundle 里没人读它；测试用它验证"点了之后键写对没有"这类行为，
		 * 免得为了跑一个函数就引入 jsdom。
		 */
		exports.__internals = {
			SOURCE_KEY: SOURCE_KEY,
			ASSET_KEY: ASSET_KEY,
			C550_LEGACY_KEY: C550_LEGACY_KEY,
			UPLOAD_PATH: UPLOAD_PATH,
			LIST_PATH: LIST_PATH,
			DELETE_PATH: DELETE_PATH,
			RENAME_PATH: RENAME_PATH,
			FROM_PATH: FROM_PATH,
			readSource: readSource,
			applySource: applySource,
			readAsset: readAsset,
			writeAsset: writeAsset,
			releaseLegacyC550: releaseLegacyC550,
			replay: replay,
			readLiveOverlay: () => liveOverlay,
			fetchImported: fetchImported,
			importFile: importFile,
			deleteImported: deleteImported,
			renameImported: renameImported,
			formatBytes: formatBytes,
			shortLabel: shortLabel,
			recordLastBoot: recordLastBoot,
			readLastBoot: readLastBoot,
			describeLastBoot: describeLastBoot,
		}
		//#endregion
		return module.exports;
	}
});
