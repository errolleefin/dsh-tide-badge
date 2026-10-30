/**
 * dsh-tide-badge —— 浏览器半边（模板）
 *
 * 由 build.mjs 把 lib/season.mjs 与 lib/pricing.mjs 内联到下面的标记处，生成最终的
 * lib/client.js。这样前端与宿主**共用同一份峰谷与节假日判定源码**，前端不必
 * 自己维护节假日表，也不会出现两端算出的切换点不一致；价目表也只有一处。
 *
 * 形态沿用 billing-badge：一枚小药丸挂在输入框下方的原生统计行里（"缓存命中"
 * 那一排），点击展开面板。数据来自宿主 /plugins/tide-badge/state 单一路由，
 * 「本次」则来自 DSH 自带的**会话级** `tokenUsage` 投影（见下面 mountChip 的注释）。
 */
window.__ModuleLoader__.load({
	id: "dsh-tide-badge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");

		// >>> tide-badge:season（由 build.mjs 从 lib/season.mjs 内联，请勿手改） >>>
		/* SEASON_INLINE */
		// <<< tide-badge:season <<<

		// >>> tide-badge:pricing（由 build.mjs 从 lib/pricing.mjs 内联，请勿手改） >>>
		/* PRICING_INLINE */
		// <<< tide-badge:pricing <<<

		const STATE_URL = "/plugins/tide-badge/state";
		const TICK_MS = 1000;
		/** 闲多久才自动刷新余额（对话区静默计时）。 */
		const IDLE_REFRESH_MS = 60 * 1000;
		/** 检查“是否已闲够”的频率。 */
		const IDLE_CHECK_MS = 5000;
		const NARROW = "(max-width: 760px)";
		const CSS_TAG_ID = "dsh-tide-badge/core.css";

		/** 样式取自原生统计行与面板，使芯片看起来是那一排的一部分。 */
		const CSS = `
.dsh-tide-badge {
  box-sizing: border-box; max-width: 100%;
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
  font: inherit; font-variant-numeric: tabular-nums; line-height: inherit;
  white-space: nowrap; background: 0 0; border: none; border-radius: 24px;
  align-items: center; gap: 6px; padding: 1px 8px; display: inline-flex;
  cursor: pointer;
}
.dsh-tide-badge:hover, .dsh-tide-badge[aria-expanded="true"] {
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
}
.dsh-tide-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.dsh-tide-muted { opacity: .6; }
.dsh-tide-balance { opacity: .85; font-variant-numeric: tabular-nums; }
.dsh-tide-balance[hidden] { display: none; }
.dsh-tide-cost[hidden] { display: none; }
/* 面板背景必须用**实心不透明**的 --dsw-alias-bg-layer-1（原生模态卡片 lc-modal-card 同款）。
   此前用的是 --dsw-specific-menu，那是覆盖层令牌、半透明，背后的对话文字会透出来。 */
.dsh-tide-panel {
  position: fixed; z-index: 1100; box-sizing: border-box;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; padding: 16px;
  box-shadow: var(--dsw-shadow-lv3, 0 12px 32px #0006);
  font-size: 12px; line-height: 18px;
  min-width: min(320px, 100vw - 24px); max-width: min(440px, 100vw - 24px);
}
.dsh-tide-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.dsh-tide-title { font-weight: 500; color: var(--dsw-alias-label-primary); flex: 1; }
.dsh-tide-refresh {
  background: 0 0; border: none; padding: 0 2px; cursor: pointer;
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font: inherit;
}
.dsh-tide-refresh:hover { color: var(--dsw-alias-label-primary); }
.dsh-tide-rows { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; }
.dsh-tide-rows dt { color: var(--dsw-alias-label-secondary); }
.dsh-tide-rows dd { margin: 0; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; text-align: right; }
.dsh-tide-badge-tag {
  font-size: 10px; padding: 0 5px; border-radius: 999px; margin-left: 4px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
  border: 1px solid var(--dsw-alias-border-l2);
}
.dsh-tide-note { margin-top: 10px; color: var(--dsw-alias-label-secondary); }
.dsh-tide-note:empty { display: none; }
.dsh-tide-err { color: var(--dsw-alias-state-warn-primary); }
.dsh-tide-foot { margin-top: 10px; color: var(--dsw-alias-label-secondary); opacity: .75; }
/* 价目区：两行——当前档位单价 / 档位与口径。数值等宽，换档时数字不跳动。 */
.dsh-tide-pricing { margin-top: 8px; }
.dsh-tide-prices { font-variant-numeric: tabular-nums; }
.dsh-tide-phase { margin-top: 2px; opacity: .9; }
`;

		/** 每页只注入一次样式表。 */
		function injectCss() {
			if (typeof document === "undefined") return;
			if (document.querySelector('style[data-plugin-css="' + CSS_TAG_ID + '"]') !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-tide-badge";
			tag.dataset.pluginCss = CSS_TAG_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/**
		 * 金额格式：**符号后置**（`123¥`、`0.5$`），跟随接口给的币种与精度。
		 *
		 * 0 也要正常显示成 `0¥`：原实现用 `/0+$/` 去尾零，遇到 `0.0000` 会被整串
		 * 吃成空、再被 `/\.$/` 吃掉小数点，最后只剩一个 `¥`。改成 `\.?0+$`
		 * 只吃「小数点及其后的零」，`0` 与 `0.50` 都能留下正确数字。
		 */
		function formatMoney(amount, currency) {
			if (typeof amount !== "number" || !Number.isFinite(amount)) return "--";
			const digits = amount >= 1 ? 2 : 4;
			const text = amount.toFixed(digits).replace(/\.?0+$/, "") || "0";
			const symbol = currency === "CNY" ? "\u00a5" : currency === "USD" ? "$" : currency === "EUR" ? "\u20ac" : "";
			if (symbol !== "") return `${text}${symbol}`;
			return `${text} ${currency || ""}`.trim();
		}

		/**
		 * token 数量的千分位写法（面板里逐桶展示用量）。
		 *
		 * 固定用 en-US 的逗号分组：界面语言是中文时 `12,345` 仍然比 `1.2345万`
		 * 更容易和原生「缓存命中」药丸的数字对齐。
		 */
		function formatTokens(value) {
			const n = Number(value);
			if (!Number.isFinite(n) || n < 0) return "--";
			return Math.round(n).toLocaleString("en-US");
		}

		/** 宿主下发的节假日清单只应用一次，避免每次渲染都重建 Set。 */
		let holidays = null;

		/**
		 * 读宿主状态。失败也返回可渲染的对象，绝不抛出。
		 *
		 * 宿主返回的 holidays 是**节假日判定的单一来源**：把它交给共用的 season
		 * 源码后，前端算出的切换点与宿主完全一致（法定节假日最容易算错切换点）。
		 */
		async function loadState(force) {
			try {
				const response = await fetch(STATE_URL + (force ? "?refresh=1" : ""), { headers: { accept: "application/json" } });
				if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
				const data = await response.json();
				const list = data && data.season && data.season.holidays;
				if (Array.isArray(list) && list.length > 0 && holidays === null) {
					holidays = list;
					setHolidays(list);
				}
				return data;
			} catch (err) {
				return { ok: false, error: String((err && err.message) || err) };
			}
		}

		/**
		 * 面板正文。
		 *
		 * 有时段数据就用宿主下发的（与宿主时刻严格一致），否则用共用的 season
		 * 源码本地算一份（节假日清单已由 setHolidays 注入）。
		 *
		 * @param {object} state 宿主 /plugins/tide-badge/state 的响应
		 * @param {object} [cost] costView()，缺省时只显示时段与余额
		 */
		function panelBody(state, cost) {
			const now = new Date();
			const season = (state && state.season) || describePhase(now);
			const bal = state && state.balance;
			const flip = season.flipAt === null || season.flipAt === undefined ? null : new Date(season.flipAt);
			const rows = [];

			const kindText = season.holiday ? "（法定节假日）" : season.weekend ? "（周末）" : "";
			rows.push(["计费时段", (season.peak ? "高峰时段（峰价）" : "空闲时段（谷价，半价）") + kindText]);
			rows.push([
				"下次切换",
				season.countdown === "" || season.countdown === undefined
					? "--"
					: `${season.countdown}后` + (flip === null ? "" : `，${beijingClock(flip).weekday} ${beijingClock(flip).clock}（北京）`),
			]);
			rows.push(["北京时间", `${season.beijing.weekday} ${season.beijing.clock}`]);

			if (cost !== undefined && cost !== null) {
				if (cost.available === true) {
					rows.push(["本次花费", formatMoney(cost.amount, "CNY") + "（按价目表估算）"]);
					if (cost.buckets !== null && cost.buckets !== undefined) {
						rows.push(["未命中输入", formatTokens(cost.buckets.uncachedInputTokens)]);
						rows.push(["缓存命中输入", formatTokens(cost.buckets.cacheReadTokens)]);
						if (Number(cost.buckets.cacheWriteTokens) > 0) {
							rows.push(["缓存写入", formatTokens(cost.buckets.cacheWriteTokens)]);
						}
						rows.push(["输出", formatTokens(cost.buckets.outputTokens)]);
					}
				} else {
					rows.push(["本次花费", "等待用量投影…", "muted"]);
				}
			}

			if (bal && bal.ok) {
				rows.push(["账户余额", formatMoney(bal.total, bal.currency) + (bal.currency ? ` ${bal.currency}` : "")]);
				const granted = typeof bal.granted === "number" ? bal.granted : 0;
				const toppedUp = typeof bal.toppedUp === "number" ? bal.toppedUp : 0;
				if (granted > 0) {
					rows.push(["赠送金额", formatMoney(bal.granted, bal.currency)]);
					if (toppedUp > 0) rows.push(["充值金额", formatMoney(bal.toppedUp, bal.currency)]);
				}
				if (bal.isAvailable === false) rows.push(["API 调用", "余额不足", "warn"]);
			} else if (bal) {
				rows.push(["账户余额", "暂不可用"]);
			}
			return rows;
		}

		/** 芯片要挂进的那一行：原生统计行（兼容两种形态）。 */
		function statsRow() {
			const legacy = document.querySelector('[data-composer-stats="true"]');
			if (legacy !== null) return legacy;
			const dock = document.querySelector('[data-slot="conversation.composer.dock"]');
			if (dock === null) return null;
			// 原生文案随语言变化，中英文都要匹配（只匹配 cache hit 会在中文界面挂不上）
			const reading = [...dock.querySelectorAll("button")].find((el) =>
				/cache hit|缓存命中/i.test(el.textContent || ""),
			);
			if (reading === undefined) return null;
			for (const child of dock.children) {
				if (child.contains(reading)) return child;
			}
			return null;
		}

		/** 挂载芯片与面板。 */
		function mountChip(row, initialSessionId) {
			injectCss();

			const chip = document.createElement("button");
			chip.type = "button";
			chip.className = "dsh-tide-badge";
			chip.setAttribute("aria-haspopup", "dialog");
			chip.setAttribute("aria-expanded", "false");

			const dot = document.createElement("span");
			dot.className = "dsh-tide-dot";
			const label = document.createElement("span");
			const count = document.createElement("span");
			count.className = "dsh-tide-muted";
			// 账户余额与本次对话花费都常显：不必点开面板就能看到。
			const balance = document.createElement("span");
			balance.className = "dsh-tide-balance";
			const cost = document.createElement("span");
			cost.className = "dsh-tide-muted dsh-tide-cost";
			chip.append(dot, label, count, balance, cost);

			let panel = null;
			let state = null;
			let tick = 0;

			/**
			 * 本次对话花费 —— 按**会话级 token 用量 × 官方价目表**记账（方案 A）。
			 *
			 * 为什么不再用余额差值：余额是**账户级**读数，同一账号的其他对话、其他
			 * API Key、手机 App 都扣同一个钱包。用它推导「本次」必然串账 —— 实测
			 * 8 个对话合计 ¥17.22，而账户实际只掉了 ¥5.25（见 issue-tide-badge.md）。
			 *
			 * 现在改成读 DSH 自带的 `tokenUsage` 会话投影（provider 每次响应自报的
			 * usage，按会话累计；原生「缓存命中」药丸读的也是它）：
			 *   · 归属由 sessionId 决定，别的对话 / 别的 API 花多少都进不来；
			 *   · 投影给的是**累计值**，所以每次拿到新值就与账本里的上一份快照逐桶
			 *     做差，再按**当时的**峰/谷档位计价累加 —— 跨 09:00 / 12:00 /
			 *     14:00 / 18:00 边界的轮次按观察时刻计价，最多错一轮，方向可预期；
			 *   · 首次见到一个会话（没有账本行）时，把它的累计用量整体按当前档位
			 *     计价：「本次」= 这个对话到目前为止的花费，而不是从 0 重新开始。
			 *     代价是重开旧会话时，它的历史轮次按此刻的档位估算。
			 *
			 * 账本按 sessionId 分开存；取不到 id 就**不记账**（宁可不显示），
			 * 绝不退回共用一条 "default" 账 —— 那正是同一笔钱被记多遍的来源。
			 */
			const LEDGER_KEY = "dsh-tide-badge/session-cost/v2";
			/** 旧版差值法账本：口径错误且已无人读取，升级时清掉。 */
			const LEGACY_LEDGER_KEY = "dsh-tide-badge/session-cost";

			/** 当前对话 id；拿不到就是 null（不记账、不显示金额）。 */
			let sessionId = typeof initialSessionId === "string" && initialSessionId !== "" ? initialSessionId : null;

			const loadLedger = () => {
				const out = {};
				try {
					const raw = window.localStorage.getItem(LEDGER_KEY);
					const parsed = raw === null ? null : JSON.parse(raw);
					const sessions = parsed !== null && typeof parsed === "object" ? parsed.sessions : null;
					if (sessions === null || typeof sessions !== "object") return out;
					for (const [id, row] of Object.entries(sessions)) {
						if (id === "" || row === null || typeof row !== "object") continue;
						if (!Number.isSafeInteger(row.costUnits) || row.costUnits < 0) continue;
						const buckets = normaliseBuckets(row.buckets);
						if (buckets === null) continue;
						out[id] = { costUnits: row.costUnits, buckets };
					}
				} catch (err) {
					/* 读不到就当新账本 */
				}
				return out;
			};

			let ledger = loadLedger();
			const saveLedger = () => {
				try {
					window.localStorage.setItem(LEDGER_KEY, JSON.stringify({ v: 2, sessions: ledger }));
				} catch (err) {
					/* 存不下不影响本次显示 */
				}
			};
			try {
				window.localStorage.removeItem(LEGACY_LEDGER_KEY);
			} catch (err) {
				/* 旧账本删不掉也无所谓 */
			}

			/** 本次对话已累计的花费（元）；未知时 null。 */
			const sessionCost = () => {
				if (sessionId === null) return null;
				const row = ledger[sessionId];
				return row === undefined ? 0 : row.costUnits / MONEY_SCALE;
			};

			/**
			 * 把一次新的用量快照记进账本。
			 *
			 * 计价与「不重复记」的规则都在 nextCostRow 里（pricing.mjs，有单测）：
			 * 账本一行只属于一个会话，所以这里不可能把别的对话的消耗算进来。
			 *
			 * @param {string} id 会话 id
			 * @param {object} raw `tokenUsage` 投影的四桶视图
			 */
			const observeUsage = (id, raw) => {
				const buckets = normaliseBuckets(raw);
				if (buckets === null) return;
				const previous = ledger[id];
				if (previous !== undefined) {
					const delta = deltaBuckets(buckets, previous.buckets);
					// 用量没变（同一次响应被重复读取）：不写盘，免得每秒刷新都落一次 localStorage。
					if (delta !== null && isEmptyBuckets(delta)) return;
				}
				const peak = describePhase(new Date()).peak;
				ledger[id] = nextCostRow(previous === undefined ? null : previous, buckets, peak);
				saveLedger();
			};

			/** 面板与芯片共用的花费视图。 */
			const costView = () => {
				const row = sessionId === null ? undefined : ledger[sessionId];
				return {
					available: row !== undefined,
					amount: row === undefined ? 0 : row.costUnits / MONEY_SCALE,
					buckets: row === undefined ? null : row.buckets,
					peak: describePhase(new Date()).peak,
				};
			};

			/**
			 * 芯片上「本次 <金额>」那一段的文案。
			 *
			 * 金额一律人民币：价目表就是人民币，与余额币种无关 —— 旧实现拿余额
			 * 币种格式化累计值，来源一换就会给人民币数字标上 $。
			 * 永远返回非空串，调用方据此常显 `本次 0¥`。
			 */
			const costText = () => {
				const cost = sessionCost();
				if (cost === null) return "本次 --";
				return "本次 " + formatMoney(cost, "CNY");
			};

			/**
			 * 芯片常显内容：档位 + 倒计时。
			 *
			 * 档位由本地共用源码判定（每秒跟随时钟），倒计时以**宿主下发的切换时刻**
			 * 为准（它已把法定节假日算进去），本地只做秒级推进。
			 */
			const render = () => {
				const local = describePhase(new Date());
				const hostFlipAt = state && state.season ? state.season.flipAt : null;
				let countText = "";
				if (typeof hostFlipAt === "number" && Number.isFinite(hostFlipAt)) {
					const remaining = hostFlipAt - Date.now();
					countText = remaining > 0 ? formatCountdown(remaining) : "";
				} else {
					countText = local.countdown || "";
				}
				dot.style.background = local.color;
				label.textContent = local.compact;
				const narrow = typeof window !== "undefined" && window.matchMedia(NARROW).matches;
				count.textContent = narrow || countText === "" ? "" : "\u00b7 " + countText;
				// 余额常显；失败时留空而不是显示占位符，避免难看。
				const bal = state && state.balance;
				const balText = bal && bal.ok === true ? formatMoney(bal.total, bal.currency) : "";
				balance.textContent = balText === "" ? "" : "\u00b7 " + balText;
				balance.hidden = balText === "";
				// 本次对话花费：always 显示，未产生消费时为 `本次 0¥`。
				// 不隐藏是刻意的 —— 新开对话看不到这一项时，用户无法分辨
				// 是"还没花钱"还是"插件坏了"。
				cost.textContent = "\u00b7 " + costText();
				cost.hidden = false;
				chip.title = local.title;
				if (panel !== null) fillPanel();
			};

			const fillPanel = () => {
				if (panel === null) return;
				const body = panel.querySelector(".dsh-tide-rows");
				const note = panel.querySelector(".dsh-tide-note");
				const cost = costView();
				body.replaceChildren();
				for (const [key, value, tone] of panelBody(state, cost)) {
					const dt = document.createElement("dt");
					dt.textContent = key;
					const dd = document.createElement("dd");
					dd.textContent = value;
					if (tone === "warn") dd.style.color = "var(--dsw-alias-state-warn-primary)";
					if (tone === "muted") dd.style.opacity = ".7";
					body.append(dt, dd);
				}
				const prices = panel.querySelector(".dsh-tide-prices");
				if (prices !== null) prices.textContent = pricingHint(cost.peak === true);
				const phase = panel.querySelector(".dsh-tide-phase");
				if (phase !== null) phase.textContent = pricingPhaseHint(cost.peak === true);
				const bal = state && state.balance;
				if (bal && bal.ok && bal.source === "account") {
					note.textContent = "余额来自桌面端账号登录态";
				} else if (bal && bal.ok && bal.source === "key") {
					note.textContent = "余额来自 API Key";
				} else {
					// 失败时把两条路的原因都摊开，方便直接定位（否则四种失败长得一样）
					const parts = [];
					if (bal && bal.accountReason) parts.push("账号路：" + String(bal.accountReason));
					if (bal && bal.error) parts.push("API Key 路：" + String(bal.error));
					note.textContent = parts.join("；");
				}
				note.classList.toggle("dsh-tide-err", Boolean(bal && bal.ok === false));
			};

			const placePanel = () => {
				if (panel === null) return;
				const rect = chip.getBoundingClientRect();
				panel.style.visibility = "hidden";
				panel.style.left = "0px";
				panel.style.top = "0px";
				const width = panel.offsetWidth;
				const height = panel.offsetHeight;
				const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8));
				const above = rect.top - height - 8;
				panel.style.left = `${left}px`;
				panel.style.top = `${above >= 8 ? above : rect.bottom + 8}px`;
				panel.style.visibility = "";
			};

			const onDocumentPointer = (event) => {
				if (panel === null) return;
				if (panel.contains(event.target) || chip.contains(event.target)) return;
				closePanel();
			};
			const onKey = (event) => {
				if (event.key === "Escape") closePanel();
			};
			let repositioning = false;
			const reposition = () => {
				if (panel === null) return;
				const rect = chip.getBoundingClientRect();
				if (rect.bottom < 0 || rect.top > window.innerHeight) {
					closePanel();
					return;
				}
				placePanel();
			};
			const onViewport = () => {
				if (panel === null || repositioning) return;
				repositioning = true;
				window.requestAnimationFrame(() => {
					repositioning = false;
					reposition();
				});
			};

			function closePanel() {
				if (panel === null) return;
				panel.remove();
				panel = null;
				chip.setAttribute("aria-expanded", "false");
				document.removeEventListener("pointerdown", onDocumentPointer, true);
				document.removeEventListener("keydown", onKey, true);
				window.removeEventListener("resize", onViewport);
				window.removeEventListener("scroll", onViewport, true);
			}

			async function openPanel() {
				if (panel !== null) return;
				panel = document.createElement("div");
				panel.className = "dsh-tide-panel";
				panel.setAttribute("role", "dialog");
				panel.setAttribute("aria-label", "计费时段与余额");
				panel.innerHTML =
					'<div class="dsh-tide-head"><span class="dsh-tide-title">计费时段与余额</span>' +
					'<button class="dsh-tide-refresh" type="button">刷新</button></div>' +
					'<dl class="dsh-tide-rows"></dl>' +
					'<div class="dsh-tide-note"></div>' +
					'<div class="dsh-tide-foot">高峰：北京时间周一至周五 09:00–12:00、14:00–18:00（不含法定节假日）</div>' +
					'<div class="dsh-tide-foot dsh-tide-pricing">' +
					'<div class="dsh-tide-prices"></div>' +
					'<div class="dsh-tide-phase"></div>' +
					'</div>';
				panel.querySelector(".dsh-tide-refresh").addEventListener("click", async () => {
					applyState(await loadState(true));
					fillPanel();
				});
				document.body.appendChild(panel);
				chip.setAttribute("aria-expanded", "true");
				fillPanel();
				placePanel();
				document.addEventListener("pointerdown", onDocumentPointer, true);
				document.addEventListener("keydown", onKey, true);
				window.addEventListener("resize", onViewport);
				window.addEventListener("scroll", onViewport, true);
				// 每次打开都取一次：面板上的余额不该是半小时前的旧值。
				// （宿主侧有 60 秒缓存，所以频繁开关也不会真的反复打接口。）
				applyState(await loadState(false));
				fillPanel();
				placePanel();
			}

			chip.addEventListener("click", () => {
				if (panel === null) void openPanel();
				else closePanel();
			});

			/**
			 * 把一份新的宿主状态交给芯片。
			 *
			 * 只负责时段/倒计时/余额；「本次」由用量投影单独驱动（见 __tideUsage），
			 * 两者互不依赖 —— 余额接口挂了也不该让花费数字消失或归零。
			 */
			const applyState = (next) => {
				state = next;
				render();
			};

			/** 供外部（自动刷新）把新数据交给这个芯片。 */
			chip.__tideApply = (next) => applyState(next);

			/**
			 * 供 React 半边把**当前会话的用量快照**交给芯片。
			 *
			 * 会话切换时 slot 组件不会重挂，只有 props 变；把 sessionId 一起传进来，
			 * 芯片才知道该读账本里的哪一行（旧实现靠嗅探「主视图持有的会话」，
			 * 切走再切回就会把整段间隔的账户消耗记到旧对话头上）。
			 */
			chip.__tideUsage = (next) => {
				if (next === null || typeof next !== "object") return;
				const id = typeof next.sessionId === "string" && next.sessionId !== "" ? next.sessionId : null;
				if (id === null) return;
				sessionId = id;
				observeUsage(id, next.buckets);
				render();
			};

			// 芯片可能是重建的（切换会话时统计行被替换）：把最近一次用量补上，
			// 否则要等下一次投影更新才会出现「本次」。
			if (latestUsage !== null) chip.__tideUsage(latestUsage);

			render();
			tick = window.setInterval(render, TICK_MS);
			// 后台静默刷新一次，让芯片的倒计时以宿主时刻为准
			void loadState(false).then((s) => {
				if (s && s.ok !== false) applyState(s);
			});

			row.appendChild(chip);

			return () => {
				window.clearInterval(tick);
				closePanel();
				chip.remove();
			};
		}

		/**
		 * 是否有任何会话正在运行（宿主会话列表快照里的 `running`）。
		 *
		 * 这只是**辅助**判据：拿不到就返回 false，让刷新照常发生 —— 绝不因为探测失败
		 * 而把自动刷新永久关掉。它解决的是「一次性长工具调用期间界面静止」这种边界，
		 * 主要判据仍是下面对话区的动静。
		 */
		function anySessionRunning() {
			try {
				const ctx = typeof globalThis !== "undefined" ? globalThis.__dshTideBadgeCtx : null;
				if (ctx === null || ctx === undefined || typeof ctx.get !== "function") return false;
				const sessions = ctx.get("sessions");
				if (sessions === null || sessions === undefined) return false;
				const list = sessions.list;
				if (list === null || list === undefined || typeof list.getSnapshot !== "function") return false;
				const snap = list.getSnapshot();
				if (snap === null || typeof snap !== "object") return false;
				// 运行态在 byId[id].running 上；旧实现读 snap.sessions，在 DSH 0.2.x
				// 上恒为空数组，于是「有会话在跑就不刷新」这层保护一直没生效。
				const byId = snap.byId;
				if (byId !== null && typeof byId === "object") {
					for (const row of Object.values(byId)) {
						if (row !== null && typeof row === "object" && row.running === true) return true;
					}
					return false;
				}
				const rows = Array.isArray(snap.sessions) ? snap.sessions : [];
				return rows.some((r) => r && r.running === true);
			} catch (err) {
				return false;
			}
		}

		/**
		 * 对话区静止检测：返回 { lastActivity(), stop() }。
		 *
		 * 观察 `[data-conversation-scroll]` 的变动 —— agent 在流式输出、工具调用刷新、
		 * 用户敲字，都会改动这棵子树。任何一次变动都刷新 lastActivity()，
		 * 于是「闲满一分钟」自然等价于「输出结束后用户一分钟没继续」。
		 */
		function startActivityWatch() {
			let last = Date.now();
			let observer = null;
			let tries = 0;

			const root = () => document.querySelector("[data-conversation-scroll]");
			const attach = () => {
				if (observer !== null) return true;
				const el = root();
				if (el === null) return false;
				observer = new MutationObserver(() => { last = Date.now(); });
				observer.observe(el, { childList: true, subtree: true, characterData: true });
				return true;
			};

			if (!attach()) {
				// 挂载早于对话区出现时，轮询直到它出现（最多约 20 秒）
				const timer = window.setInterval(() => {
					tries += 1;
					if (attach() || tries > 40) window.clearInterval(timer);
				}, 500);
				return {
					lastActivity: () => last,
					stop: () => { window.clearInterval(timer); if (observer !== null) observer.disconnect(); },
				};
			}
			return {
				lastActivity: () => last,
				stop: () => { if (observer !== null) observer.disconnect(); },
			};
		}

		/** 最近一次收到的用量快照（会话 id + 四桶）。芯片重建时用它把账补上。 */
		let latestUsage = null;

		/** 无渲染占位：唯一职责是让芯片始终附着在原生统计行上。 */
		function TideMount(props) {
			const sessionId = props === null || props === undefined ? undefined : props.sessionId;
			const useProjection = props === null || props === undefined ? undefined : props.useProjection;
			// 会话级用量投影：原生「缓存命中」药丸读的也是它。取不到时保持
			// undefined，芯片显示「本次 0¥」，时段与余额不受影响。
			const usage = typeof useProjection === "function" ? useProjection("tokenUsage") : undefined;

			react.useEffect(() => {
				if (typeof sessionId !== "string" || sessionId === "") return undefined;
				latestUsage = { sessionId, buckets: usage };
				const chip = document.querySelector(".dsh-tide-badge");
				if (chip !== null && typeof chip.__tideUsage === "function") chip.__tideUsage(latestUsage);
				return undefined;
			}, [sessionId, usage]);

			react.useEffect(() => {
				let teardown = null;
				let scheduled = false;

				const attach = () => {
					if (teardown !== null && document.querySelector(".dsh-tide-badge") !== null) return;
					const row = statsRow();
					if (row === null) return;
					if (teardown !== null) teardown();
					teardown = mountChip(row, latestUsage === null ? sessionId : latestUsage.sessionId);
				};

				const schedule = () => {
					if (scheduled) return;
					scheduled = true;
					window.requestAnimationFrame(() => {
						scheduled = false;
						attach();
					});
				};

				attach();
				const observer = new MutationObserver(schedule);
				observer.observe(document.body, { childList: true, subtree: true });

				// 自动刷新：对话中不动，闲满一分钟且没有会话在跑才取一次新数据
				const watch = startActivityWatch();
				const idleTimer = window.setInterval(() => {
					const chip = document.querySelector(".dsh-tide-badge");
					if (chip === null) return;                                  // 没挂载就没必要请求
					if (typeof document.hidden === "boolean" && document.hidden) return; // 页面在后台
					if (Date.now() - watch.lastActivity() < IDLE_REFRESH_MS) return;     // 还在对话
					if (anySessionRunning()) return;                            // 有会话说在跑
					void loadState(false).then((s) => {
						if (s && s.ok !== false && typeof chip.__tideApply === "function") chip.__tideApply(s);
					});
				}, IDLE_CHECK_MS);

				return () => {
					observer.disconnect();
					window.clearInterval(idleTimer);
					watch.stop();
					if (teardown !== null) teardown();
				};
			}, []);
			return null;
		}

		const inject = ["slots"];

		function apply(ctx) {
			// 供自动刷新时探测“是否有会话在跑”。挂到 globalThis 是因为探测发生在
			// mountChip 的定时器里，那里拿不到 apply 的闭包。
			try { globalThis.__dshTideBadgeCtx = ctx; } catch (err) { /* 忽略 */ }
			ctx.slots.inject("conversation.composer.dock", () =>
				ctx.slots.register(
					{ name: "conversation.composer.dock", id: "tide-badge", order: 10 },
					TideMount,
				),
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.__internal = { mountChip, panelBody, statsRow };
		return module.exports;
	},
});
