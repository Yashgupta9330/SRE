CREATE TABLE IF NOT EXISTS products (
  id       INTEGER PRIMARY KEY,
  name     TEXT NOT NULL,
  category TEXT NOT NULL,
  price    REAL NOT NULL
);

-- Serves the baseline search (filter by category, ordered by price).
CREATE INDEX IF NOT EXISTS idx_products_category_price ON products (category, price);
