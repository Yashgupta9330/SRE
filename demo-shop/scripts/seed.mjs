// Generates demo-shop/seed.sql with 10,000 products (deterministic).
// Kept small on purpose: D1's free plan includes 5M rows read per day, and a
// full-table-scan search reads every row on every call.
import { writeFileSync } from "node:fs";

const N = 10_000;
const categories = ["shoes", "shirts", "jackets", "bags", "hats", "socks", "watches", "belts", "scarves", "gloves"];
const adjectives = ["red", "blue", "classic", "vintage", "slim", "sport", "leather", "wool", "summer", "winter", "urban", "trail"];

let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

const rows = [];
for (let id = 1; id <= N; id++) {
  const category = categories[id % categories.length];
  const name = `${adjectives[Math.floor(rand() * adjectives.length)]} ${category.slice(0, -1)} ${id}`;
  const price = (5 + rand() * 195).toFixed(2);
  rows.push(`(${id}, '${name}', '${category}', ${price})`);
}

const statements = ["DELETE FROM products;"];
for (let i = 0; i < rows.length; i += 500) {
  statements.push(`INSERT INTO products (id, name, category, price) VALUES\n${rows.slice(i, i + 500).join(",\n")};`);
}
writeFileSync(new URL("../seed.sql", import.meta.url), statements.join("\n"));
console.log(`wrote demo-shop/seed.sql (${N} products)`);
