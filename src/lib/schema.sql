-- Core skin data from skins.json
CREATE TABLE IF NOT EXISTS skins (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  weapon_name TEXT NOT NULL,
  pattern_name TEXT NOT NULL,
  rarity_id TEXT NOT NULL,
  rarity_name TEXT NOT NULL,
  min_float REAL NOT NULL DEFAULT 0.0,
  max_float REAL NOT NULL DEFAULT 1.0,
  has_stattrak INTEGER NOT NULL DEFAULT 0,
  has_souvenir INTEGER NOT NULL DEFAULT 0,
  image_url TEXT,
  paint_index INTEGER
);

-- One row per wear x variant (normal, stattrak, souvenir) from skins_not_grouped.json
CREATE TABLE IF NOT EXISTS skin_variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skin_id TEXT NOT NULL,
  market_hash_name TEXT NOT NULL UNIQUE,
  wear_name TEXT NOT NULL,
  is_stattrak INTEGER NOT NULL DEFAULT 0,
  is_souvenir INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (skin_id) REFERENCES skins(id)
);

-- Collection metadata
CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  image_url TEXT
);

-- Junction table: skins <-> collections with rarity context
CREATE TABLE IF NOT EXISTS collection_skins (
  collection_id TEXT NOT NULL,
  skin_id TEXT NOT NULL,
  rarity_id TEXT NOT NULL,
  PRIMARY KEY (collection_id, skin_id),
  FOREIGN KEY (collection_id) REFERENCES collections(id),
  FOREIGN KEY (skin_id) REFERENCES skins(id)
);

-- Cached Steam market prices
CREATE TABLE IF NOT EXISTS prices (
  market_hash_name TEXT PRIMARY KEY,
  lowest_price_cents INTEGER,
  median_price_cents INTEGER,
  volume INTEGER,
  sell_listings INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Scraper state for resume capability
CREATE TABLE IF NOT EXISTS scrape_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Indexes for query performance
CREATE INDEX IF NOT EXISTS idx_skins_name ON skins(name);
CREATE INDEX IF NOT EXISTS idx_skin_variants_skin_id ON skin_variants(skin_id);
CREATE INDEX IF NOT EXISTS idx_skin_variants_market_hash_name ON skin_variants(market_hash_name);
CREATE INDEX IF NOT EXISTS idx_collection_skins_collection_id ON collection_skins(collection_id);
CREATE INDEX IF NOT EXISTS idx_collection_skins_rarity_id ON collection_skins(rarity_id);
CREATE INDEX IF NOT EXISTS idx_collection_skins_skin_id ON collection_skins(skin_id);
