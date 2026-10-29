/**
 * cache-mode — 给经 Magpie 订阅桥接的 Claude 切换缓存时长：
 *   日常（daily）：1h 缓存，慢慢聊；集中（focus）：5m 缓存，连续干活更省；关闭（off）：交还给 Magpie 默认。
 *
 * 做法：给 magpie provider 注册一个请求包装。命中的 Claude 模型改走 Anthropic 协议（/v1/messages），
 * 带上 `X-Magpie-Cache-Marks: client`，让 Magpie 按 pi 写的 cache_control 来定 TTL（magpie #1717）；
 * 其他模型原样走 openai-completions。模型本身已经走 Anthropic 协议时，用请求事件补上缓存控制。
 * 不改 models.json，Magpie 同步重写它也不受影响。
 *
 * 模式存在 ~/.pi/agent/cache-mode.json；每个会话最后一次 Claude 请求的时间写到
 * ~/.pi/agent/cache-mode.state.json，cache-expiry-guard 和 pi-web-ui 的 cache-rain 插件都读它。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	streamAnthropic,
	streamOpenAICompletions,
	streamSimpleAnthropic,
	streamSimpleOpenAICompletions,
} from "@earendil-works/pi-ai";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Mode = "daily" | "focus" | "off";
interface Config {
	mode: Mode;
	/** 最近一次手动或自动切换的时间，避免旧会话让刚选的集中模式立即退出 */
	modeChangedAt?: number;
	/** 要接管的 provider（pi 里 Magpie 的 provider id） */
	provider: string;
	/** 匹配模型 id 的正则（不区分大小写），默认匹配含可选网关前缀的 Claude 订阅模型 */
	modelPattern: string;
	/** 集中模式下，所有会话都超过这么多分钟没有 Claude 请求，下一条消息前自动切回日常；0 = 不自动切 */
	focusAutoOffMinutes: number;
	/** Magpie 网关根地址（不带 /v1）；留空就从 provider 的 baseUrl 去掉 /v1 推出来 */
	anthropicBaseUrl: string;
}
interface SessionEntry { at: number; ttlSec: number; mode: Mode; model: string; dropped?: string }
interface State { sessions: Record<string, SessionEntry> }

const AGENT_DIR = join(homedir(), ".pi", "agent");
const CONFIG_PATH = process.env.PI_CACHE_MODE_CONFIG ?? join(AGENT_DIR, "cache-mode.json");
const STATE_PATH = process.env.PI_CACHE_MODE_STATE ?? join(AGENT_DIR, "cache-mode.state.json");
const DEFAULTS: Config = {
	mode: "daily",
	provider: "magpie",
	modelPattern: "^(?:[^/]+/)*claude/",
	focusAutoOffMinutes: 0,
	anthropicBaseUrl: "",
};
const TTL_SEC: Record<Mode, number> = { daily: 3600, focus: 300, off: 3600 };
const MAX_SESSIONS = 60;
const STATUS_KEY = "cache-mode";

const MODE_LABEL: Record<Mode, string> = {
	daily: "☀ 日常 · 1h 缓存",
	focus: "☔ 集中 · 5m 缓存",
	off: "关闭（交给 Magpie，默认 1h）",
};
const LINES = {
	focus: "☔ 『我將全心全意將其奪回，在這暴風雨停息之前。』（集中模式：每次请求续命 5 分钟）",
	daily: "☀ 雨過天晴。這一次，我能活一個小時。（日常模式：1h 缓存）",
	off: "雨伞收起来了。缓存交还给 Magpie（默认 1h）。",
	autoOff: (min: number) => `雨已经停了 ${min} 分钟。『暴雨結束之時，就是我的死期。』——切回日常 1h 缓存。`,
	focusToDaily: "雨还没停就撑起太阳：Magpie 要新开一次会话，这一轮会把整段上下文按 1h 从头重写一次缓存。",
};

function readJson<T>(path: string): Partial<T> | undefined {
	try {
		if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
	} catch { /* 坏 JSON 当不存在 */ }
	return undefined;
}
function writeJson(path: string, value: unknown) {
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
	renameSync(tmp, path);
}
function loadConfig(): Config {
	const c = { ...DEFAULTS, ...(readJson<Config>(CONFIG_PATH) ?? {}) };
	if (!["daily", "focus", "off"].includes(c.mode)) c.mode = "daily";
	return c;
}
function saveMode(mode: Mode) {
	const raw = readJson<Config>(CONFIG_PATH) ?? {};
	writeJson(CONFIG_PATH, { ...raw, mode, modeChangedAt: Date.now() });
}
function loadState(): State {
	const s = readJson<State>(STATE_PATH);
	return { sessions: s?.sessions && typeof s.sessions === "object" ? s.sessions : {} };
}
function recordRequest(sessionId: string, patch: Partial<SessionEntry>) {
	try {
		const state = loadState();
		const prev = state.sessions[sessionId];
		state.sessions[sessionId] = { ...(prev ?? { at: 0, ttlSec: 0, mode: "daily", model: "" }), ...patch } as SessionEntry;
		const ids = Object.keys(state.sessions).sort((a, b) => state.sessions[b].at - state.sessions[a].at);
		for (const id of ids.slice(MAX_SESSIONS)) delete state.sessions[id];
		writeJson(STATE_PATH, state);
	} catch { /* 记录失败不影响请求 */ }
}

const matches = (cfg: Config, model: { provider?: string; id?: string } | undefined) => {
	if (!model || model.provider !== cfg.provider || !model.id) return false;
	try { return new RegExp(cfg.modelPattern, "i").test(model.id); } catch { return false; }
};

/** Claude 4.6 及以后只接受 adaptive thinking（与 Magpie 的 adaptiveOnly 一致） */
function adaptiveOnly(id: string) {
	const m = /claude-(?:opus|sonnet|haiku)-(\d+)(?:[-.](\d+))?/i.exec(id);
	if (!m) return false;
	const major = Number(m[1]);
	const minor = m[2] && m[2].length <= 2 ? Number(m[2]) : 0;
	return major > 4 || (major === 4 && minor >= 6);
}

function gatewayRoot(cfg: Config, baseUrl: string) {
	if (cfg.anthropicBaseUrl) return cfg.anthropicBaseUrl.replace(/\/+$/, "");
	return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** provider.stream 和 provider.streamSimple 都会进到扩展的 streamSimple，靠选项形状分辨 */
function isSimpleCall(o: any) {
	if (!o || o.reasoning !== undefined) return true;
	return o.reasoningEffort === undefined && o.thinkingEnabled === undefined && o.effort === undefined;
}

function fmtClock(ms: number) {
	const d = new Date(ms);
	return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

export default function (pi: ExtensionAPI) {
	const boot = loadConfig();

	const wrapped = (model: any, context: any, options?: any) => {
		const cfg = loadConfig();
		const simple = isSimpleCall(options);
		if (cfg.mode === "off" || !matches(cfg, model)) {
			return simple ? streamSimpleOpenAICompletions(model, context, options) : streamOpenAICompletions(model, context, options);
		}

		const am = {
			...model,
			api: "anthropic-messages",
			baseUrl: gatewayRoot(cfg, model.baseUrl ?? ""),
			headers: { ...(model.headers ?? {}), "X-Magpie-Cache-Marks": "client" },
			compat: {
				...(model.compat ?? {}),
				// 工具由 Claude Code 自己管，标在工具上的缓存点 Magpie 只会丢掉并报告
				supportsCacheControlOnTools: false,
				supportsLongCacheRetention: true,
				...(adaptiveOnly(model.id) ? { forceAdaptiveThinking: true } : {}),
			},
		};
		const retention = options?.cacheRetention === "none" ? "none" : cfg.mode === "focus" ? "short" : "long";
		const sessionId: string | undefined = options?.sessionId;
		const userOnResponse = options?.onResponse;
		const opts: any = {
			...(options ?? {}),
			cacheRetention: retention,
			onResponse: async (res: { status: number; headers: Record<string, string> }, m: any) => {
				if (sessionId && retention !== "none" && res.status < 400) {
					const dropped = res.headers?.["x-magpie-cache-marks-dropped"];
					recordRequest(sessionId, { dropped: dropped || undefined });
				}
				return userOnResponse?.(res, m);
			},
		};
		if (!simple && options?.reasoningEffort !== undefined && opts.thinkingEnabled === undefined) {
			opts.thinkingEnabled = true;
			opts.effort = options.reasoningEffort;
			delete opts.reasoningEffort;
		}
		// 缓存在请求开始处理时续命，按请求发出时间记，倒计时只会偏保守
		if (sessionId && retention !== "none") {
			recordRequest(sessionId, { at: Date.now(), ttlSec: TTL_SEC[cfg.mode], mode: cfg.mode, model: model.id });
		}
		return simple ? streamSimpleAnthropic(am, context, opts) : streamAnthropic(am, context, opts);
	};

	pi.registerProvider(boot.provider, { api: "openai-completions", streamSimple: wrapped as any });

	// 原生 anthropic-messages 不经过上面的 OpenAI 包装，必须从实际请求事件接管。
	// SDK 先组装 headers，再生成 payload；按会话保存本次请求选择，直到 payload 确认模型和缓存点。
	const nativePending = new Map<string, { mode: Mode; model: string }>();
	const nativeResponses = new Set<string>();
	pi.on("before_provider_headers", (event, ctx) => {
		const sid = ctx.sessionManager.getSessionId?.();
		if (!sid) return;
		nativePending.delete(sid);
		nativeResponses.delete(sid);
		const cfg = loadConfig();
		const model = ctx.model;
		if (cfg.mode === "off" || model?.api !== "anthropic-messages" || !matches(cfg, model)) return;
		for (const key of Object.keys(event.headers)) {
			if (key.toLowerCase() === "x-magpie-cache-marks") delete event.headers[key];
		}
		event.headers["X-Magpie-Cache-Marks"] = "client";
		nativePending.set(sid, { mode: cfg.mode, model: model.id });
	});
	pi.on("before_provider_request", (event, ctx) => {
		const sid = ctx.sessionManager.getSessionId?.();
		const pending = sid ? nativePending.get(sid) : undefined;
		if (!sid || !pending) return;
		nativePending.delete(sid);
		const raw = event.payload as any;
		if (raw?.model !== pending.model) return;
		let cached = false;
		const setTTL = (block: any) => {
			if (block?.cache_control?.type !== "ephemeral") return block;
			cached = true;
			const { ttl: _ttl, ...control } = block.cache_control;
			return { ...block, cache_control: { ...control, ...(pending.mode === "daily" ? { ttl: "1h" } : {}) } };
		};
		const payload = setTTL({
			...raw,
			...(Array.isArray(raw.system) ? { system: raw.system.map(setTTL) } : {}),
			...(Array.isArray(raw.messages) ? { messages: raw.messages.map((message: any) => ({
				...message,
				...(Array.isArray(message.content) ? { content: message.content.map(setTTL) } : {}),
			})) } : {}),
			...(Array.isArray(raw.tools) ? { tools: raw.tools.map((tool: any) => {
				const { cache_control: _control, ...definition } = tool;
				return definition;
			}) } : {}),
		});
		// SDK 的 cacheRetention:none 没有缓存点，保持不记录、不启动倒计时。
		if (cached) {
			recordRequest(sid, { at: Date.now(), ttlSec: TTL_SEC[pending.mode], mode: pending.mode, model: pending.model, dropped: undefined });
			nativeResponses.add(sid);
		}
		return payload;
	});
	pi.on("after_provider_response", (event, ctx) => {
		const sid = ctx.sessionManager.getSessionId?.();
		if (!sid || !nativeResponses.delete(sid) || event.status >= 400) return;
		recordRequest(sid, { dropped: event.headers["x-magpie-cache-marks-dropped"] || undefined });
	});
	pi.on("session_shutdown", (_event, ctx) => {
		const sid = ctx.sessionManager.getSessionId?.();
		if (sid) { nativePending.delete(sid); nativeResponses.delete(sid); }
	});

	const refreshStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const cfg = loadConfig();
		if (cfg.mode === "off" || !matches(cfg, ctx.model as any)) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		let text = MODE_LABEL[cfg.mode];
		const sid = ctx.sessionManager.getSessionId?.();
		const e = sid ? loadState().sessions[sid] : undefined;
		if (e?.at && e.mode === cfg.mode) {
			const end = e.at + e.ttlSec * 1000;
			text += end > Date.now()
				? cfg.mode === "focus" ? ` · 『雨停之後，我就會死。』雨会下到 ${fmtClock(end)}` : ` · 缓存到 ${fmtClock(end)}`
				: cfg.mode === "focus" ? " · 『暴雨結束之時，就是我的死期。』" : " · 缓存已过期";
		}
		ctx.ui.setStatus(STATUS_KEY, text);
	};

	const syncModel = (ctx: ExtensionContext) => {
		const cfg = loadConfig();
		if (cfg.mode !== "off" && !matches(cfg, ctx.model as any)) saveMode("off");
		refreshStatus(ctx);
	};

	const switchMode = (ctx: ExtensionContext, next: Mode, why?: string) => {
		const prev = loadConfig().mode;
		if (prev === next) {
			ctx.ui.notify(`已经是「${MODE_LABEL[next]}」`, "info");
			return;
		}
		saveMode(next);
		ctx.ui.notify(why ?? LINES[next], "info");
		refreshStatus(ctx);
	};

	pi.registerCommand("cache-mode", {
		description: "切换 Magpie Claude 的缓存时长：daily（1h）/ focus（5m）/ off；不带参数弹出选择",
		handler: async (args, ctx) => {
			syncModel(ctx);
			const arg = (args ?? "").trim().toLowerCase();
			const alias: Record<string, Mode> = {
				daily: "daily", "1h": "daily", 日常: "daily", long: "daily",
				focus: "focus", "5m": "focus", 集中: "focus", short: "focus",
				off: "off", 关闭: "off",
			};
			if (arg === "status" || (!arg && !ctx.hasUI)) {
				const cfg = loadConfig();
				const sid = ctx.sessionManager.getSessionId?.();
				const e = sid ? loadState().sessions[sid] : undefined;
				const tail = e?.at ? `；本会话最后一次 Claude 请求 ${fmtClock(e.at)}（${e.mode}，${e.ttlSec / 60} 分钟）${e.dropped ? `；Magpie 丢掉的缓存点：${e.dropped}` : ""}` : "";
				const mode = matches(cfg, ctx.model as any) ? cfg.mode : "off";
				ctx.ui.notify(`当前：${mode === "off" && !matches(cfg, ctx.model as any) ? "关闭（当前模型不在缓存配置范围内）" : MODE_LABEL[mode]}${tail}`, "info");
				return;
			}
			if (!matches(loadConfig(), ctx.model as any)) {
				ctx.ui.notify("当前模型不在缓存配置范围内，缓存模式已关闭；切回匹配模型后可选 5m 或 1h。", arg && alias[arg] !== "off" ? "warning" : "info");
				return;
			}
			let next: Mode | undefined = alias[arg];
			if (!next) {
				if (arg) { ctx.ui.notify(`不认识「${arg}」，可选 daily / focus / off / status`, "warning"); return; }
				const cur = loadConfig().mode;
				const labels = (["daily", "focus", "off"] as Mode[]).map((m) => `${MODE_LABEL[m]}${m === cur ? "（当前）" : ""}`);
				const pick = await ctx.ui.select("缓存模式", labels);
				if (pick === undefined) return;
				next = (["daily", "focus", "off"] as Mode[])[labels.indexOf(pick)];
			}
			const cur = loadConfig().mode;
			if (cur === "focus" && next === "daily") {
				const sid = ctx.sessionManager.getSessionId?.();
				const e = sid ? loadState().sessions[sid] : undefined;
				if (e?.at && Date.now() - e.at < e.ttlSec * 1000) {
					switchMode(ctx, next, `${LINES.daily}\n注意：${LINES.focusToDaily}`);
					return;
				}
			}
			switchMode(ctx, next);
		},
	});

	pi.on("session_start", async (_e, ctx) => syncModel(ctx));
	pi.on("model_select", async (_e, ctx) => syncModel(ctx));
	pi.on("turn_end", async (_e, ctx) => refreshStatus(ctx));
	pi.on("agent_end", async (_e, ctx) => refreshStatus(ctx));

	// 手动进入集中模式也算活动；旧会话的记录不能让刚选择的模式立即退出。
	pi.on("input", async (event: any, ctx) => {
		const cfg = loadConfig();
		if (cfg.mode !== "focus" || !(cfg.focusAutoOffMinutes > 0) || event.source === "extension") return { action: "continue" };
		if (!matches(cfg, ctx.model as any)) return { action: "continue" };
		const entries = Object.values(loadState().sessions).filter((e) => e.mode === "focus" && Number.isFinite(e.at));
		let changedAt = cfg.modeChangedAt;
		// 兼容旧版配置及手动编辑配置文件的情况。
		try { changedAt = Math.max(Number.isFinite(changedAt) ? changedAt! : 0, statSync(CONFIG_PATH).mtimeMs); } catch { /* 文件刚被移走时仍使用已读取的时间 */ }
		const last = Math.max(Number.isFinite(changedAt) ? changedAt! : 0, ...entries.map((e) => e.at));
		if (!last) return { action: "continue" };
		const idleMin = (Date.now() - last) / 60000;
		if (idleMin > cfg.focusAutoOffMinutes) {
			saveMode("daily");
			if (ctx.hasUI) ctx.ui.notify(LINES.autoOff(Math.round(idleMin)), "info");
			refreshStatus(ctx);
		}
		return { action: "continue" };
	});
}
