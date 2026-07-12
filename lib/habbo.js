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

// Fetch marketplace stats for one or more items in a single batched call
export const fetchHabboStats = async (items) => {
	const payload = { roomItems: [], wallItems: [] };

	for (const { classname, type } of items) {
		if (type === 'room') payload.roomItems.push({ item: classname });
		else if (type === 'wall') payload.wallItems.push({ item: classname });
	}

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
};

// Markdown block for a single item's stats (stats may be null/undefined)
export const buildPriceBlock = (name, stats) => {
	const safeName = escapeMarkdown(name);

	if (!stats) {
		return `❌ *${safeName}* — no marketplace data (may be non-tradable)`;
	}

	return `📊 *${safeName}*
💰 Average: ${stats.averagePrice} credits
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
	const blocks = zipStats(shown, data).map(({ item, stats }) => buildPriceBlock(item.name, stats));

	const footer = overflow > 0 ? `\n\n…and ${overflow} more match${overflow === 1 ? '' : 'es'}. Refine your search to see them.` : '';

	return blocks.join('\n\n') + footer;
};
