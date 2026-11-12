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
  has_stattrak BOOLEAN NOT NULL DEFAULT FALSE,
  has_souvenir BOOLEAN NOT NULL DEFAULT FALSE,
  image_url TEXT,
  paint_index INTEGER
);

-- One row per wear x variant (normal, stattrak, souvenir) from skins_not_grouped.json
CREATE TABLE IF NOT EXISTS skin_variants (
  id SERIAL PRIMARY KEY,
  skin_id TEXT NOT NULL REFERENCES skins(id),
  market_hash_name TEXT NOT NULL UNIQUE,
  wear_name TEXT NOT NULL,
  is_stattrak BOOLEAN NOT NULL DEFAULT FALSE,
  is_souvenir BOOLEAN NOT NULL DEFAULT FALSE
);

-- Collection metadata
CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  image_url TEXT
);

-- Junction table: skins <-> collections with rarity context
CREATE TABLE IF NOT EXISTS collection_skins (
  collection_id TEXT NOT NULL REFERENCES collections(id),
  skin_id TEXT NOT NULL REFERENCES skins(id),
  rarity_id TEXT NOT NULL,
  PRIMARY KEY (collection_id, skin_id)
);

-- Crate (case) metadata
CREATE TABLE IF NOT EXISTS crates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  image_url TEXT
);

-- Junction table: skins <-> crates with rarity context and rare flag
CREATE TABLE IF NOT EXISTS crate_skins (
  crate_id TEXT NOT NULL REFERENCES crates(id),
  skin_id TEXT NOT NULL REFERENCES skins(id),
  rarity_id TEXT NOT NULL,
  is_rare BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (crate_id, skin_id)
);

-- Listing state of each tracked variant, from Steam's market search.
--   lowest_price_cents  lowest active listing in USD cents; NULL = confirmed to
--                       have no active listing
--   sell_listings       number of active listings
--   updated_at          when that was last confirmed
-- median_price_cents and volume are no longer written or read (they came from
-- the retired priceoverview scraper).
CREATE TABLE IF NOT EXISTS prices (
  market_hash_name TEXT PRIMARY KEY,
  lowest_price_cents INTEGER,
  median_price_cents INTEGER,
  volume INTEGER,
  sell_listings INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Average of the last 5 Steam sales per variant, from the listing page's sale
-- history. Trade-up outcomes are valued at this figure.
--   avg_last5_cents  USD cents; NULL when there is no sale to average
--   sample_count     sales in the average; 0 = Steam has none on record;
--                    NULL = never read successfully (rows written before the
--                    2026-11 rebuild are all in this state)
--   last_sale_at     time of the most recent sale (ISO 8601)
--   updated_at       last successful read; a failed read never touches the row
CREATE TABLE IF NOT EXISTS last_sold_avg (
  market_hash_name TEXT PRIMARY KEY REFERENCES skin_variants(market_hash_name),
  avg_last5_cents INTEGER,
  sample_count INTEGER,
  last_sale_at TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Key/value state for the background jobs: scan progress (listings:*), locks
-- (lock:*), one health record per job (job:*), and Steam currency rates (fx:*).
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
CREATE INDEX IF NOT EXISTS idx_crate_skins_crate_id ON crate_skins(crate_id);
CREATE INDEX IF NOT EXISTS idx_crate_skins_skin_id ON crate_skins(skin_id);
CREATE INDEX IF NOT EXISTS idx_crate_skins_rarity_id ON crate_skins(rarity_id);
CREATE INDEX IF NOT EXISTS idx_crate_skins_is_rare ON crate_skins(is_rare);
