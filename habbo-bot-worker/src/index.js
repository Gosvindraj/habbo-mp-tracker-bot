import {
	MAX_QUERY_LENGTH,
	MAX_MATCHES,
	FURNIDATA_URL,
	USER_AGENT,
	fetchWithTimeout,
	findMatches,
	fetchHabboStats,
	buildPriceMessage,
	buildPriceBlock,
	zipStats,
	escapeMarkdown,
} from '../../lib/habbo.js';

const WHITELIST_ID = [729525685, 5069716116];

export default {
	async fetch(request, env, ctx) {
		// Only process POST requests from Telegram
		if (request.method === 'POST') {
			try {
				const payload = await request.json();
				const userId = payload.message?.from?.id ?? payload.inline_query?.from?.id;

				// Check if the user is whitelisted
				if (!WHITELIST_ID.includes(userId)) {
					console.warn(`Unauthorized access attempt by user ID: ${userId}`);
					return new Response('Unauthorized', { status: 200 });
				}

				if (payload.inline_query) {
					ctx.waitUntil(handleInlineQuery(payload.inline_query, env));
				} else if (payload.message && payload.message.text) {
					const chatId = payload.message.chat.id;
					const text = payload.message.text.trim();

					// Ack Telegram immediately; finish the work in the background
					// so slow Habbo responses don't make Telegram re-deliver the webhook
					ctx.waitUntil(routeCommand(chatId, text, env));
				}
			} catch (e) {
				console.error('Error processing webhook:', e);
			}
			return new Response('OK');
		}
		return new Response('Habbo Bot is Active');
	},

	// Cron trigger: record prices for watched items and fire alerts
	async scheduled(event, env, ctx) {
		ctx.waitUntil(checkWatches(env));
	},
};

// --- Command routing ---

async function routeCommand(chatId, text, env) {
	try {
		if (text.startsWith('/price')) {
			await handlePriceCommand(chatId, text.replace('/price', '').trim(), env);
		} else if (text.startsWith('/watchlist')) {
			await handleWatchlistCommand(chatId, env);
		} else if (text.startsWith('/watch')) {
			await handleWatchCommand(chatId, text.replace('/watch', '').trim(), env);
		} else if (text.startsWith('/unwatch')) {
			await handleUnwatchCommand(chatId, text.replace('/unwatch', '').trim(), env);
		} else if (text.startsWith('/history')) {
			await handleHistoryCommand(chatId, text.replace('/history', '').trim(), env);
		} else if (text.startsWith('/help') || text.startsWith('/start')) {
			await sendTelegram(
				chatId,
				`Commands:
/price <item name> — marketplace prices (partial names work)
/watch <item name> <credits> — alert when price drops to/below the amount
/unwatch <item name> — stop watching an item
/watchlist — show your watched items
/history <item name> — 30-day price trend of any item`,
				env,
			);
		}
	} catch (e) {
		console.error('routeCommand error:', e);
		await sendTelegram(chatId, '⚠️ Something went wrong. Please try again later.', env);
	}
}

// --- /price ---

async function handlePriceCommand(chatId, inputName, env) {
	if (!inputName) {
		return await sendTelegram(chatId, 'Usage: /price <item name>', env);
	}

	if (inputName.length > MAX_QUERY_LENGTH) {
		return await sendTelegram(chatId, `❌ Search term is too long (max ${MAX_QUERY_LENGTH} characters). Try a shorter name.`, env);
	}

	await sendTelegram(chatId, `🔍 Checking marketplace for: ${inputName}...`, env);

	const matches = findMatches(await fetchFurnidata(), inputName);

	if (matches.length === 0) {
		return await sendTelegram(chatId, `❌ Could not find any item matching "${inputName}".`, env);
	}

	const shown = matches.slice(0, MAX_MATCHES);
	const overflow = matches.length - shown.length;

	// Single batched call covers every shown match
	const data = await fetchHabboStats(shown);

	await sendTelegram(chatId, buildPriceMessage(shown, data, overflow), env, 'Markdown');
}

// --- /watch ---

async function handleWatchCommand(chatId, args, env) {
	// Last token is the price threshold, everything before it is the item name
	const parts = args.split(/\s+/);
	const threshold = Number(parts.at(-1));
	const itemName = parts.slice(0, -1).join(' ');

	if (!itemName || !Number.isInteger(threshold) || threshold <= 0) {
		return await sendTelegram(chatId, 'Usage: /watch <item name> <credits>\nExample: /watch throne 50', env);
	}

	const matches = findMatches(await fetchFurnidata(), itemName);
	if (matches.length === 0) {
		return await sendTelegram(chatId, `❌ Could not find any item matching "${itemName}".`, env);
	}

	// Best-ranked match wins (exact > prefix > substring)
	const item = matches[0];

	await env.DB.prepare(
		`INSERT INTO watches (chat_id, classname, item_type, item_name, threshold)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT (chat_id, classname, item_type)
		 DO UPDATE SET threshold = excluded.threshold, alerted = 0`,
	)
		.bind(chatId, item.classname, item.type, item.name, threshold)
		.run();

	await sendTelegram(
		chatId,
		`🔔 Watching *${escapeMarkdown(item.name)}* — you'll get an alert when its price drops to ${threshold} credits or below. (Checked every 30 minutes.)`,
		env,
		'Markdown',
	);
}

// --- /unwatch ---

async function handleUnwatchCommand(chatId, itemName, env) {
	if (!itemName) {
		return await sendTelegram(chatId, 'Usage: /unwatch <item name>', env);
	}

	const result = await env.DB.prepare(`DELETE FROM watches WHERE chat_id = ? AND lower(item_name) = lower(?)`)
		.bind(chatId, itemName)
		.run();

	if (result.meta.changes > 0) {
		await sendTelegram(chatId, `✅ Stopped watching "${itemName}".`, env);
	} else {
		await sendTelegram(chatId, `❌ You're not watching "${itemName}". Use /watchlist to see your watches (use the exact listed name).`, env);
	}
}

// --- /watchlist ---

async function handleWatchlistCommand(chatId, env) {
	const { results } = await env.DB.prepare(`SELECT item_name, threshold, alerted FROM watches WHERE chat_id = ? ORDER BY item_name`)
		.bind(chatId)
		.all();

	if (results.length === 0) {
		return await sendTelegram(chatId, 'Your watchlist is empty. Add one with /watch <item name> <credits>.', env);
	}

	const lines = results.map(
		(w) => `${w.alerted ? '🔔' : '👀'} *${escapeMarkdown(w.item_name)}* — alert at ≤ ${w.threshold} credits${w.alerted ? ' (triggered)' : ''}`,
	);

	await sendTelegram(chatId, `Your watchlist:\n\n${lines.join('\n')}`, env, 'Markdown');
}

// --- Inline mode: @botname <query> in any chat ---

const INLINE_MAX_RESULTS = 8;

// Furni icon for result thumbnails; * in classnames maps to _ in icon filenames
const iconUrl = (item) =>
	item.revision ? `https://images.habbo.com/dcr/hof_furni/${item.revision}/${item.classname.replace(/\*/g, '_')}_icon.png` : undefined;

async function handleInlineQuery(inlineQuery, env) {
	try {
		const query = inlineQuery.query.trim();
		let results = [];

		// Telegram fires an inline query on every keystroke; skip 0-1 char noise
		if (query.length >= 2 && query.length <= MAX_QUERY_LENGTH) {
			const matches = findMatches(await fetchFurnidata(), query).slice(0, INLINE_MAX_RESULTS);

			if (matches.length > 0) {
				const data = await fetchHabboStats(matches);

				results = zipStats(matches, data).map(({ item, stats }, i) => ({
					type: 'article',
					id: String(i),
					title: item.name,
					description: stats
						? `Avg ${stats.averagePrice} · Current ${stats.currentPrice} · ${stats.currentOpenOffers} listed`
						: 'No marketplace data',
					thumbnail_url: iconUrl(item),
					input_message_content: {
						message_text: buildPriceBlock(item.name, stats),
						parse_mode: 'Markdown',
					},
				}));
			}
		}

		await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/answerInlineQuery`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				inline_query_id: inlineQuery.id,
				results,
				cache_time: 120,
				// Personal: results must not be served from Telegram's cache to
				// other (non-whitelisted) users typing the same query
				is_personal: true,
			}),
		});
	} catch (e) {
		console.error('handleInlineQuery error:', e);
	}
}

// --- /history ---

// Render values as a Unicode sparkline: ▁▂▃▄▅▆▇█
const SPARK_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
function sparkline(values) {
	const min = Math.min(...values);
	const max = Math.max(...values);
	const range = max - min || 1; // flat series renders as all-low bars
	return values.map((v) => SPARK_CHARS[Math.round(((v - min) / range) * (SPARK_CHARS.length - 1))]).join('');
}

// Line chart PNG via QuickChart (Workers have no canvas). Colors follow the
// validated palette: series #2a78d6 on #fcfcfb, hairline grid, muted axis ink.
function buildLineChartUrl(title, labels, values) {
	const config = {
		type: 'line',
		data: {
			labels,
			datasets: [
				{
					data: values,
					borderColor: '#2a78d6',
					backgroundColor: 'rgba(42,120,214,0.12)',
					borderWidth: 2,
					pointRadius: values.length < 5 ? 3 : 0,
					fill: true,
					lineTension: 0.25,
				},
			],
		},
		options: {
			legend: { display: false },
			title: { display: true, text: title, fontColor: '#0b0b0b' },
			scales: {
				xAxes: [{ gridLines: { display: false }, ticks: { fontColor: '#898781', maxTicksLimit: 7, maxRotation: 0 } }],
				yAxes: [{ gridLines: { color: '#e1e0d9', drawBorder: false }, ticks: { fontColor: '#898781', maxTicksLimit: 6 } }],
			},
		},
	};

	return `https://quickchart.io/chart?w=700&h=360&bkg=${encodeURIComponent('#fcfcfb')}&c=${encodeURIComponent(JSON.stringify(config))}`;
}

function buildHistoryChartUrl(itemName, days, statsDate) {
	const base = new Date(`${statsDate}T00:00:00Z`);
	const labels = days.map((d) => {
		const dt = new Date(base.getTime() + d.offset * 86400000);
		return `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}`;
	});
	return buildLineChartUrl(`${itemName} — avg sold price (credits)`, labels, days.map((d) => d.avgPrice));
}

// Intraday chart from our 30-minute snapshots; recorded_at is UTC "YYYY-MM-DD HH:MM:SS"
function buildIntradayChartUrl(itemName, snaps) {
	const labels = snaps.map((s) => s.recorded_at.slice(11, 16));
	return buildLineChartUrl(`${itemName} — cheapest open offer, 30-min checks (UTC)`, labels, snaps.map((s) => s.current_price));
}

async function handleHistoryCommand(chatId, itemName, env) {
	if (!itemName) {
		return await sendTelegram(chatId, 'Usage: /history <item name>', env);
	}

	const matches = findMatches(await fetchFurnidata(), itemName);
	if (matches.length === 0) {
		return await sendTelegram(chatId, `❌ Could not find any item matching "${itemName}".`, env);
	}

	// Best-ranked match, same resolution as /watch
	const item = matches[0];

	// The stats API returns ~30 days of daily history alongside current prices
	const data = await fetchHabboStats([item]);
	const stats = item.type === 'room' ? data?.roomItemData?.[0] : data?.wallItemData?.[0];

	// Days without sales carry no meaningful average price
	const days = (stats?.history ?? [])
		.map((d) => ({
			offset: Number(d.dayOffset),
			avgPrice: Number(d.averagePrice),
			sold: Number(d.totalSoldItems),
		}))
		.filter((d) => d.sold > 0 && d.avgPrice > 0)
		.sort((a, b) => a.offset - b.offset); // oldest → newest

	if (days.length === 0) {
		return await sendTelegram(chatId, `📉 No sales recorded for "${item.name}" in the last 30 days. It might be rarely traded or non-tradable.`, env);
	}

	const prices = days.map((d) => d.avgPrice);
	const totalSold = days.reduce((sum, d) => sum + d.sold, 0);
	const min = Math.min(...prices);
	const max = Math.max(...prices);
	const spanDays = -days[0].offset;

	const caption = `📈 *${escapeMarkdown(item.name)}* — last ${spanDays} days

💰 Latest avg: *${prices.at(-1)}* credits · ⬇️ Low: ${min} · ⬆️ High: ${max}
📦 Sold: ${totalSold} items over ${days.length} trading days
🏷️ Cheapest offer now: ${stats.currentPrice} credits (${stats.currentOpenOffers} listed)`;

	// Supplementary intraday view from our own 30-minute snapshots (watched items only)
	const { results: snaps } = await env.DB.prepare(
		`SELECT current_price, recorded_at FROM price_history
		 WHERE classname = ? AND item_type = ? AND current_price IS NOT NULL
		 ORDER BY recorded_at DESC LIMIT 48`,
	)
		.bind(item.classname, item.type)
		.all();

	const charts = [buildHistoryChartUrl(item.name, days, stats.statsDate)];
	if (snaps.length >= 2) {
		charts.push(buildIntradayChartUrl(item.name, snaps.reverse()));
	}

	const sent =
		charts.length > 1 ? await sendMediaGroup(chatId, charts, caption, env, 'Markdown') : await sendPhoto(chatId, charts[0], caption, env, 'Markdown');

	// Fall back to the text sparkline if the chart images can't be delivered
	if (!sent) {
		await sendTelegram(chatId, `${caption}\n\n\`${sparkline(prices)}\``, env, 'Markdown');
	}
}

// --- Cron: check prices, record history, send alerts ---

async function checkWatches(env) {
	const { results: watches } = await env.DB.prepare(`SELECT * FROM watches`).all();
	if (watches.length === 0) return;

	// Deduplicate items across users so each is fetched (and recorded) once
	const itemKey = (w) => `${w.item_type}:${w.classname}`;
	const uniqueItems = [...new Map(watches.map((w) => [itemKey(w), { classname: w.classname, type: w.item_type }])).values()];

	const data = await fetchHabboStats(uniqueItems);

	// Stats come back in the same order as the room/wall items sent
	let roomIdx = 0;
	let wallIdx = 0;
	const statsByKey = new Map();
	for (const item of uniqueItems) {
		const stats = item.type === 'room' ? data?.roomItemData?.[roomIdx++] : data?.wallItemData?.[wallIdx++];
		statsByKey.set(`${item.type}:${item.classname}`, stats ?? null);
	}

	const statements = [];

	// Record a history snapshot per unique item
	for (const item of uniqueItems) {
		const stats = statsByKey.get(`${item.type}:${item.classname}`);
		if (!stats) continue;
		statements.push(
			env.DB.prepare(`INSERT INTO price_history (classname, item_type, avg_price, current_price, open_offers) VALUES (?, ?, ?, ?, ?)`).bind(
				item.classname,
				item.type,
				stats.averagePrice ?? null,
				stats.currentPrice ?? null,
				stats.currentOpenOffers ?? null,
			),
		);
	}

	// Evaluate each watch against the fresh price
	for (const watch of watches) {
		const stats = statsByKey.get(itemKey(watch));
		if (!stats || !stats.currentOpenOffers) continue; // no offers = no buyable price

		const price = stats.currentPrice;

		if (price <= watch.threshold && !watch.alerted) {
			await sendTelegram(
				watch.chat_id,
				`🔔 *Price alert!* ${escapeMarkdown(watch.item_name)} is now *${price} credits* (your threshold: ${watch.threshold}). ${stats.currentOpenOffers} listed.`,
				env,
				'Markdown',
			);
			statements.push(env.DB.prepare(`UPDATE watches SET alerted = 1 WHERE id = ?`).bind(watch.id));
		} else if (price > watch.threshold && watch.alerted) {
			// Price rose back above threshold — re-arm the alert
			statements.push(env.DB.prepare(`UPDATE watches SET alerted = 0 WHERE id = ?`).bind(watch.id));
		}
	}

	if (statements.length > 0) await env.DB.batch(statements);
}

// --- Furnidata cache ---

// Warm-isolate cache: survives between requests while the Worker stays loaded
let furniCache = null;
let furniCacheTime = 0;
const FURNI_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Fetch furnidata with two cache layers:
// 1. module-global variable (fastest, lives while the isolate is warm)
// 2. Cloudflare Cache API (per-datacenter HTTP cache, survives isolate restarts)
async function fetchFurnidata() {
	if (furniCache && Date.now() - furniCacheTime < FURNI_CACHE_TTL_MS) {
		return furniCache;
	}

	const cache = caches.default;
	let response = await cache.match(FURNIDATA_URL);

	if (!response) {
		console.log('📥 Downloading fresh furnidata...');
		const origin = await fetchWithTimeout(FURNIDATA_URL, {
			headers: { 'User-Agent': USER_AGENT },
		});

		if (!origin.ok) throw new Error(`Furnidata fetch error: ${origin.status}`);

		const contentType = origin.headers.get('content-type');
		if (!contentType || !contentType.includes('application/json')) {
			const text = await origin.text();
			throw new Error(`Furnidata returned non-JSON: ${text.substring(0, 100)}`);
		}

		// Re-wrap so we control cache lifetime regardless of origin headers
		response = new Response(origin.body, origin);
		response.headers.set('Cache-Control', 'max-age=86400');
		await cache.put(FURNIDATA_URL, response.clone());
	}

	const data = await response.json();
	furniCache = data;
	furniCacheTime = Date.now();
	return data;
}

// --- Telegram ---

// Send 2-10 photos as one album; the caption rides on the first item
// (Telegram shows it under the album when only one item is captioned).
// Returns true on success.
async function sendMediaGroup(chatId, photoUrls, caption, env, parseMode = '') {
	try {
		const media = photoUrls.map((url, i) => ({
			type: 'photo',
			media: url,
			...(i === 0 ? { caption, parse_mode: parseMode } : {}),
		}));
		const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMediaGroup`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ chat_id: chatId, media }),
		});
		if (!res.ok) console.error('sendMediaGroup failed:', res.status, await res.text());
		return res.ok;
	} catch (e) {
		console.error('sendMediaGroup error:', e);
		return false;
	}
}

// Send a photo by URL (Telegram fetches it). Returns true on success.
async function sendPhoto(chatId, photoUrl, caption, env, parseMode = '') {
	try {
		const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendPhoto`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				chat_id: chatId,
				photo: photoUrl,
				caption,
				parse_mode: parseMode,
			}),
		});
		if (!res.ok) console.error('sendPhoto failed:', res.status, await res.text());
		return res.ok;
	} catch (e) {
		console.error('sendPhoto error:', e);
		return false;
	}
}

async function sendTelegram(chatId, text, env, parseMode = '') {
	await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			chat_id: chatId,
			text: text,
			parse_mode: parseMode,
		}),
	});
}
