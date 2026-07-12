import {
	MAX_QUERY_LENGTH,
	MAX_MATCHES,
	FURNIDATA_URL,
	USER_AGENT,
	fetchWithTimeout,
	findMatches,
	fetchHabboStats,
	buildPriceMessage,
} from './lib/habbo.js';

const token = process.env.TELEGRAM_TOKEN;
if (!token) {
	console.error('❌ TELEGRAM_TOKEN environment variable is not set. Run: setx TELEGRAM_TOKEN "<your token>" and restart the terminal.');
	process.exit(1);
}
const API = `https://api.telegram.org/bot${token}`;

// --- Telegram (dependency-free) ---

const sendMessage = async (chatId, text, parseMode = '') => {
	try {
		const res = await fetch(`${API}/sendMessage`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ chat_id: chatId, text, parse_mode: parseMode }),
		});
		if (!res.ok) console.error('sendMessage failed:', res.status, await res.text());
	} catch (e) {
		console.error('sendMessage error:', e);
	}
};

// Long-poll getUpdates forever. Telegram holds the request open up to 30s
// when there are no updates, so this loop is idle-cheap.
const pollUpdates = async () => {
	let offset = 0;

	console.log('🤖 Bot started, polling for updates...');

	while (true) {
		try {
			const res = await fetch(`${API}/getUpdates?timeout=30&offset=${offset}`);
			const body = await res.json();

			if (!body.ok) {
				console.error('getUpdates error:', body);
				await new Promise((r) => setTimeout(r, 5000));
				continue;
			}

			for (const update of body.result) {
				offset = update.update_id + 1;
				handleUpdate(update).catch((e) => console.error('handleUpdate error:', e));
			}
		} catch (e) {
			console.error('Polling error:', e);
			await new Promise((r) => setTimeout(r, 5000));
		}
	}
};

const handleUpdate = async (update) => {
	const text = update.message?.text;
	const chatId = update.message?.chat?.id;
	if (!text || !chatId) return;

	const match = text.match(/^\/price (.+)/);
	if (match) await handlePriceCommand(chatId, match[1].trim());
};

// --- Commands ---

const handlePriceCommand = async (chatId, inputName) => {
	if (inputName.length > MAX_QUERY_LENGTH) {
		return sendMessage(chatId, `❌ Search term is too long (max ${MAX_QUERY_LENGTH} characters). Try a shorter name.`);
	}

	await sendMessage(chatId, `🔍 Checking marketplace for: ${inputName}...`);

	try {
		const matches = findMatches(await fetchFurnidata(), inputName);

		if (matches.length === 0) {
			return sendMessage(chatId, `❌ Could not find any item matching "${inputName}".`);
		}

		const shown = matches.slice(0, MAX_MATCHES);
		const overflow = matches.length - shown.length;

		// Single batched call covers every shown match
		const data = await fetchHabboStats(shown);

		await sendMessage(chatId, buildPriceMessage(shown, data, overflow), 'Markdown');
	} catch (error) {
		console.error(error);
		sendMessage(chatId, '⚠️ Failed to fetch data. Please try again later.');
	}
};

// --- Furnidata cache (in-memory with daily refresh) ---

let furniCache = null;
let furniCacheTime = 0;
const FURNI_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // Refresh daily so new furni releases show up

const fetchFurnidata = async () => {
	if (furniCache && Date.now() - furniCacheTime < FURNI_CACHE_TTL_MS) return furniCache;

	console.log('📥 Downloading fresh furnidata...');
	const response = await fetchWithTimeout(FURNIDATA_URL, {
		headers: { 'User-Agent': USER_AGENT },
	});

	if (!response.ok) throw new Error(`Furnidata fetch error: ${response.status}`);

	const data = await response.json();
	furniCache = data;
	furniCacheTime = Date.now();
	return data;
};

pollUpdates();
