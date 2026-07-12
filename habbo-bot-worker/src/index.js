import {
	MAX_QUERY_LENGTH,
	MAX_MATCHES,
	FURNIDATA_URL,
	USER_AGENT,
	fetchWithTimeout,
	findMatches,
	fetchHabboStats,
	buildPriceMessage,
} from '../../lib/habbo.js';

const WHITELIST_ID = [729525685, 5069716116];

export default {
	async fetch(request, env, ctx) {
		// Only process POST requests from Telegram
		if (request.method === 'POST') {
			try {
				const payload = await request.json();
				const userId = payload.message?.from?.id;

				// Check if the user is whitelisted
				if (!WHITELIST_ID.includes(userId)) {
					console.warn(`Unauthorized access attempt by user ID: ${userId}`);
					return new Response('Unauthorized', { status: 200 });
				}

				if (payload.message && payload.message.text) {
					const chatId = payload.message.chat.id;
					const text = payload.message.text;

					if (text.startsWith('/price')) {
						const inputName = text.replace('/price', '').trim();
						// Ack Telegram immediately; finish the work in the background
						// so slow Habbo responses don't make Telegram re-deliver the webhook
						ctx.waitUntil(handlePriceCommand(chatId, inputName, env));
					}
				}
			} catch (e) {
				console.error('Error processing webhook:', e);
			}
			return new Response('OK');
		}
		return new Response('Habbo Bot is Active');
	},
};

// --- Commands ---

async function handlePriceCommand(chatId, inputName, env) {
	try {
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
	} catch (e) {
		console.error('handlePriceCommand error:', e);
		await sendTelegram(chatId, '⚠️ Failed to fetch data. Please try again later.', env);
	}
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
