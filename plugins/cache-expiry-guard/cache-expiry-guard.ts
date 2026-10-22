/**
 * cache-expiry-guard — 续聊前检测 Claude 缓存是否可能已过期，弹窗让你选：
 *   直接发送 / 先用便宜模型压缩再发 / 生成交接总结
 * 阈值可用环境变量覆盖（测试用）。/cache-guard-test 让下一条消息强制弹窗。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";

const CONFIG_PATH = process.env.PI_CEG_CONFIG ?? join(homedir(), ".pi", "agent", "cache-expiry-guard.json");
// cache-mode 扩展的模式文件：集中模式（5m 缓存）下用 focusIdleMinutes 当过期阈值
const CACHE_MODE_PATH = process.env.PI_CACHE_MODE_CONFIG ?? join(homedir(), ".pi", "agent", "cache-mode.json");
function focusModeFor(modelId: string): boolean {
	try {
		if (!existsSync(CACHE_MODE_PATH)) return false;
		const m = JSON.parse(readFileSync(CACHE_MODE_PATH, "utf8"));
		if (m?.mode !== "focus") return false;
		const [provider, ...rest] = modelId.split("/");
		return provider === (m.provider ?? "magpie") && new RegExp(m.modelPattern ?? "^claude/", "i").test(rest.join("/"));
	} catch { return false; }
}
const HANDOFF_DIR = ".pi-handoff";
interface Rule { pattern: string; idleMinutes?: number; minContextTokens?: number }
interface Config { idleMinutes: number; focusIdleMinutes: number; minContextTokens: number; cheapProvider: string; cheapModel: string; guards: Rule[] }
const DEFAULTS: Config = {
	idleMinutes: 55,
	focusIdleMinutes: 4.5,
	minContextTokens: 50_000,
	cheapProvider: "magpie",
	cheapModel: "antigravity/gemini-3.8-flash",
	guards: [{ pattern: "claude" }],
};
function loadConfig(): Config {
	let c: Config = { ...DEFAULTS };
	try { if (existsSync(CONFIG_PATH)) c = { ...c, ...JSON.parse(readFileSync(CONFIG_PATH, "utf8")) }; } catch { /* 坏 JSON 用默认 */ }
	const env = process.env;
	if (env.PI_CEG_IDLE_MIN) c.idleMinutes = Number(env.PI_CEG_IDLE_MIN);
	if (env.PI_CEG_MIN_TOKENS) c.minContextTokens = Number(env.PI_CEG_MIN_TOKENS);
	return c;
}
const matchRule = (c: Config, model: string) => c.guards.find((g) => new RegExp(g.pattern, "i").test(model));

const OPT_SEND = "直接发送";
const OPT_COMPACT = "先用便宜模型压缩再发";
const OPT_HANDOFF = "生成交接总结";

function scanBranch(ctx: ExtensionContext, rule: Rule) {
	const re = new RegExp(rule.pattern, "i");
	const branch = ctx.sessionManager.getBranch() as any[];
	let lastModel: string | undefined;
	let lastMatchTime: number | undefined;
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i];
		if (e?.type !== "message" || e.message?.role !== "assistant") continue;
		const m = `${e.message.provider ?? ""}/${e.message.model ?? ""}`;
		if (lastModel === undefined) lastModel = m;
		if (re.test(m)) {
			lastMatchTime = e.message.timestamp ?? (e.timestamp ? Date.parse(e.timestamp) : undefined);
			break;
		}
	}
	return { lastModel, lastMatchTime };
}

async function cheapComplete(ctx: ExtensionContext, prompt: string, signal?: AbortSignal) {
	const c = loadConfig();
	const model = ctx.modelRegistry.find(c.cheapProvider, c.cheapModel);
	if (!model) throw new Error(`找不到便宜模型 ${c.cheapProvider}/${c.cheapModel}`);
	const res = await ctx.modelRegistry.complete(
		model,
		{ messages: [{ role: "user" as const, content: [{ type: "text" as const, text: prompt }], timestamp: Date.now() }] },
		{ maxTokens: 8192, signal, cacheRetention: "none" },
	);
	const text = res.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
	if (!text.trim()) throw new Error("便宜模型返回了空内容");
	return { text, usage: res.usage };
}

const SUMMARY_PROMPT = (conv: string, prev?: string) => `你是对话总结器。总结下面这段编码对话，覆盖：目标、关键决定及原因、改过的文件和重要代码细节、当前进度、未解决问题、下一步。要具体（文件路径、函数名、命令），用结构化 markdown。${prev ? `\n\n之前的总结：\n${prev}` : ""}\n\n<conversation>\n${conv}\n</conversation>`;

const HANDOFF_PROMPT = (conv: string) => `把下面的编码对话整理成一份“交接提示词”，用于在全新对话中让另一个 AI 无缝接手。包括：项目与目标、已完成的工作、关键文件路径与设计决定、当前状态、待办与下一步、注意事项。直接输出提示词正文（markdown），不要多余说明。\n\n<conversation>\n${conv}\n</conversation>`;

export default function (pi: ExtensionAPI) {
	let useCheapCompaction = false;
	let bypassNext = false;
	let forceNext = false;

	pi.registerCommand("cache-guard-test", {
		description: "下一条消息强制弹出缓存过期提示（测试用）",
		handler: async (_args, ctx) => {
			forceNext = true;
			ctx.ui.notify("cache-expiry-guard：下一条消息会强制弹窗", "info");
		},
	});

	// 交接卡片只给人看：每次请求都固定剔除，保证前缀稳定，不影响缓存
	pi.on("context", async (event: any) => {
		const msgs = event.messages as any[];
		if (!msgs.some((m) => m?.role === "custom" && m.customType === "cache-handoff")) return;
		return { messages: msgs.filter((m) => !(m?.role === "custom" && m.customType === "cache-handoff")) };
	});

	pi.on("session_before_compact", async (event: any, ctx) => {
		if (!useCheapCompaction) return;
		useCheapCompaction = false;
		const { preparation, signal } = event;
		const all = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
		try {
			const conv = serializeConversation(convertToLlm(all));
			const { text, usage } = await cheapComplete(ctx, SUMMARY_PROMPT(conv, preparation.previousSummary), signal);
			return { compaction: { summary: text, firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore, usage } };
		} catch (err: any) {
			ctx.ui.notify(`便宜模型压缩失败，改用默认压缩：${err?.message ?? err}`, "warning");
			return;
		}
	});

	pi.on("input", async (event: any, ctx) => {
		if (event.source === "extension" || event.streamingBehavior) return { action: "continue" };
		if (bypassNext) { bypassNext = false; return { action: "continue" }; }
		const force = forceNext;
		forceNext = false;

		const modelId = `${ctx.model?.provider ?? ""}/${ctx.model?.id ?? ""}`;
		const tokens = ctx.getContextUsage()?.tokens ?? 0;
		const cfg = loadConfig();
		const rule = matchRule(cfg, modelId);
		let reason: string | undefined;
		if (rule) {
			const focus = focusModeFor(modelId);
			const idleLimit = focus ? Math.min(rule.idleMinutes ?? cfg.idleMinutes, cfg.focusIdleMinutes) : (rule.idleMinutes ?? cfg.idleMinutes);
			const minTok = rule.minContextTokens ?? cfg.minContextTokens;
			const re = new RegExp(rule.pattern, "i");
			const { lastModel, lastMatchTime } = scanBranch(ctx, rule);
			const idleMin = lastMatchTime ? (Date.now() - lastMatchTime) / 60000 : Infinity;
			if (tokens > minTok) {
				if (lastModel && !re.test(lastModel)) reason = `模型切换接手（上一轮是 ${lastModel}）`;
				else if (lastMatchTime === undefined && lastModel) reason = `模型切换接手（本会话之前没用过 ${rule.pattern}）`;
				else if (idleMin > idleLimit) reason = focus
					? `『暴雨結束之時，就是我的死期。』（集中模式 5m 缓存，距上次 ${rule.pattern} 回复约 ${Math.round(idleMin)} 分钟）`
					: `缓存过期（距上次 ${rule.pattern} 回复约 ${Math.round(idleMin)} 分钟）`;
			}
		}
		if (!reason && force) reason = "测试（/cache-guard-test 强制）";
		if (!reason) return { action: "continue" };

		const msg = `原因：${reason}；直接发送需整段重写约 ${Math.round(tokens / 1000)}k token。`;
		if (!ctx.hasUI) { return { action: "continue" }; }
		const choice = await ctx.ui.select(`${rule?.pattern ?? ""} 缓存将整段重写 · ${msg}`, [OPT_SEND, OPT_COMPACT, OPT_HANDOFF]);

		if (choice === OPT_COMPACT) {
			const text: string = event.text;
			const images = event.images;
			useCheapCompaction = true;
			ctx.ui.notify(`正在用 ${loadConfig().cheapModel} 压缩…完成后自动发送你的消息`, "info");
			ctx.compact({
				onComplete: () => {
					ctx.ui.notify("压缩完成，正在发送", "info");
					bypassNext = true;
					pi.sendUserMessage(images?.length ? [{ type: "text", text }, ...images] : text);
				},
				onError: (e) => {
					useCheapCompaction = false;
					ctx.ui.notify(`压缩失败：${e.message}。消息未发送，请重新发送。`, "error");
				},
			});
			return { action: "handled" };
		}

		if (choice === OPT_HANDOFF) {
			try {
				ctx.ui.notify(`正在用 ${loadConfig().cheapModel} 生成交接总结…`, "info");
				const msgs = (ctx.sessionManager.getBranch() as any[]).filter((e) => e.type === "message").map((e) => e.message);
				const conv = serializeConversation(convertToLlm(msgs));
				const { text } = await cheapComplete(ctx, HANDOFF_PROMPT(conv), ctx.signal);
				const dir = join(ctx.cwd, HANDOFF_DIR);
				mkdirSync(dir, { recursive: true });
				const ts = new Date().toISOString().replace(/[:.]/g, "-");
				const file = join(dir, `handoff-${ts}.md`);
				writeFileSync(file, `${text}\n\n---\n## 接下来的请求\n${event.text}\n`);
				pi.sendMessage({
					customType: "cache-handoff",
					display: true,
					content: `交接总结（已存到 ${file}；用消息上的复制按钮复制，新开会话粘贴即可。本卡片不会发给模型）\n\n\`\`\`\`markdown\n${text}\n\n---\n## 接下来的请求\n${event.text}\n\`\`\`\``,
				});
				ctx.ui.notify(`交接总结已保存：${file}\n已在对话里显示，可一键复制（原消息未发送）。`, "info");
			} catch (err: any) {
				ctx.ui.notify(`生成交接总结失败：${err?.message ?? err}（原消息未发送）`, "error");
			}
			return { action: "handled" };
		}

		if (choice === undefined) { ctx.ui.notify("已取消，消息未发送", "info"); return { action: "handled" }; }
		return { action: "continue" };
	});
}
