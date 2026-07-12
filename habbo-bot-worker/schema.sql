-- Habbo tracker schema. Apply with:
--   npx wrangler d1 execute habbo-tracker --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS watches (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	chat_id INTEGER NOT NULL,
	classname TEXT NOT NULL,
	item_type TEXT NOT NULL CHECK (item_type IN ('room', 'wall')),
	item_name TEXT NOT NULL,
	threshold INTEGER NOT NULL,
	-- alerted flag prevents re-alerting every 30 min while the price stays
	-- below threshold; it resets when the price rises back above it
	alerted INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	UNIQUE (chat_id, classname, item_type)
);

CREATE TABLE IF NOT EXISTS price_history (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	classname TEXT NOT NULL,
	item_type TEXT NOT NULL,
	avg_price INTEGER,
	current_price INTEGER,
	open_offers INTEGER,
	recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_history_item ON price_history (classname, item_type, recorded_at);
