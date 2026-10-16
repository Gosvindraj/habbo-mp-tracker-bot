// Shared Habbo marketplace logic used by both the local bot (bot.js)
// and the Cloudflare Worker (habbo-bot-worker). Keep this file runtime-agnostic:
// no Node-only or Workers-only APIs, only standard fetch/JS.

export const FETCH_TIMEOUT_MS = 15000;
export const MAX_QUERY_LENGTH = 50;
export const MAX_MATCHES = 10;
export const FURNIDATA_URL = 'https://www.habbo.com/gamedata/furnidata_json/1';
export const USER_AGENT = 'PersonalHabboTracker/1.0';

// fetch() with a hard timeout so a stalled Habbo request can't hang a command forever
export const fetchWithTimeout = (url, options = {}) => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
};

// Escape Markdown control characters in dynamic values (item names, user input)
// so a name like "Snow_Storm*" can't break formatting or fail the send
export const escapeMarkdown = (text) => String(text).replace(/([_*`\[])/g, '\\$1');

// Find every item whose name contains the search term,
// ranked: exact match first, then prefix matches, then substring matches.
// Takes already-fetched furnidata so callers own their caching strategy.
export const findMatches = (furnidata, humanName) => {
	const searchName = humanName.toLowerCase();

	const rank = (name) => {
		if (name === searchName) return 0;
		if (name.startsWith(searchName)) return 1;
		if (name.includes(searchName)) return 2;
		return -1; // not a match
	};

	const collect = (list, type) =>
		list.flatMap((item) => {
			const r = rank((item.name ?? '').toLowerCase());
			return r === -1 ? [] : [{ classname: item.classname, type, name: item.name, revision: item.revision, rank: r }];
		});

	return [...collect(furnidata.roomitemtypes.furnitype, 'room'), ...collect(furnidata.wallitemtypes.furnitype, 'wall')].sort(
		(a, b) => a.rank - b.rank || a.name.length - b.name.length,
	);
};

// The batch API rejects requests with more than 25 items per type (HTTP 400)
export const MAX_BATCH_PER_TYPE = 25;

// LTD classnames carry an "ltd" segment: ltd_habberge3, LTD_fashionistam,
// xmas_ltd25_frostegg. Excludes lookalikes such as wf_ltdproto_* and clothing_mltdshirt.
export const isLtd = (classname) => /(^|_)ltd(\d|_|$)/i.test(classname ?? '');

// Each LTD listing has its own extraData (its serial), and the API only matches
// current offers on exact classname + extraData, so currentPrice/currentOpenOffers
// are always 0 for LTDs. The daily history still counts their open offers, so
// the most recent day is the best available "listed" figure.
export const latestHistoryOpenOffers = (stats) => {
	const latest = (stats?.history ?? []).reduce((a, b) => (a && Number(a.dayOffset) >= Number(b.dayOffset) ? a : b), null);
	return latest ? Number(latest.totalOpenOffers) : null;
};

// Fetch marketplace stats for any number of items. Calls are batched (never one
// per item) and split into chunks of MAX_BATCH_PER_TYPE to stay under the API cap.
// The merged response keeps the same order as the room/wall items sent.
export const fetchHabboStats = async (items) => {
	const roomItems = [];
	const wallItems = [];

	for (const { classname, type } of items) {
		if (type === 'room') roomItems.push({ item: classname });
		else if (type === 'wall') wallItems.push({ item: classname });
	}

	const chunkCount = Math.max(1, Math.ceil(Math.max(roomItems.length, wallItems.length) / MAX_BATCH_PER_TYPE));

	const responses = await Promise.all(
		Array.from({ length: chunkCount }, async (_, i) => {
			const payload = {
				roomItems: roomItems.slice(i * MAX_BATCH_PER_TYPE, (i + 1) * MAX_BATCH_PER_TYPE),
				wallItems: wallItems.slice(i * MAX_BATCH_PER_TYPE, (i + 1) * MAX_BATCH_PER_TYPE),
			};

			const response = await fetchWithTimeout('https://www.habbo.com/api/public/marketplace/stats/batch', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'User-Agent': USER_AGENT,
				},
				body: JSON.stringify(payload),
			});

			if (!response.ok) throw new Error(`Habbo API Error: ${response.status}`);

			return await response.json();
		}),
	);

	return {
		roomItemData: responses.flatMap((r) => r?.roomItemData ?? []),
		wallItemData: responses.flatMap((r) => r?.wallItemData ?? []),
	};
};

// An average of 0 means nothing sold in the stats window, not a 0-credit price
const formatAverage = (stats) => (stats.averagePrice > 0 ? `${stats.averagePrice} credits` : 'no sales in the last 30 days');

// Markdown block for a single item's stats (stats may be null/undefined).
// item needs { name, classname }.
export const buildPriceBlock = (item, stats) => {
	const safeName = escapeMarkdown(item.name);

	if (!stats) {
		return `❌ *${safeName}* — no marketplace data (may be non-tradable)`;
	}

	if (isLtd(item.classname)) {
		const listed = latestHistoryOpenOffers(stats);
		return `📊 *${safeName}* (LTD)
💰 Average: ${formatAverage(stats)}${listed === null ? '' : `\n🔸 Listed: ~${listed} items (latest daily count)`}
ℹ️ Live LTD offers aren't exposed by the Habbo API (each serial is listed separately)`;
	}

	return `📊 *${safeName}*
💰 Average: ${formatAverage(stats)}
🏷️ Current: ${stats.currentPrice} credits
🔸 Listed: ${stats.currentOpenOffers} items`;
};

// Pair each match with its stats from the batched response. Stats come back in
// the same order as the room/wall items sent, so a separate cursor per type
// lines them back up with names.
export const zipStats = (shown, data) => {
	let roomIdx = 0;
	let wallIdx = 0;
	return shown.map((item) => ({
		item,
		stats: (item.type === 'room' ? data?.roomItemData?.[roomIdx++] : data?.wallItemData?.[wallIdx++]) ?? null,
	}));
};

// Build the Markdown reply for a set of matches and their batched stats response
export const buildPriceMessage = (shown, data, overflow) => {
	const blocks = zipStats(shown, data).map(({ item, stats }) => buildPriceBlock(item, stats));

	const footer = overflow > 0 ? `\n\n…and ${overflow} more match${overflow === 1 ? '' : 'es'}. Refine your search to see them.` : '';

	return blocks.join('\n\n') + footer;
};
