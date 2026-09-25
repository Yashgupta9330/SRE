// Traffic generator for demo-shop.
//   node demo-shop/scripts/load.mjs <base-url> [minutes=3]
// ~3 product lookups/s plus 1 search every 2 s. With the full-text search
// flag on, each search scans the whole table (10k rows read), so a 3-minute
// run reads ~1M rows: stay within D1's free 5M rows/day.
const base = (process.argv[2] ?? "").replace(/\/$/, "");
const minutes = Number(process.argv[3] ?? 3);
if (!base.startsWith("http")) {
  console.error("usage: node demo-shop/scripts/load.mjs https://demo-shop.<subdomain>.workers.dev [minutes]");
  process.exit(1);
}

const terms = ["red", "classic", "leather", "sport", "wool", "trail"];
const categories = ["shoes", "shirts", "jackets", "bags", "hats"];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const stats = { ok: 0, failed: 0, totalMs: 0 };

async function hit(path) {
  const t0 = Date.now();
  try {
    const r = await fetch(base + path);
    await r.arrayBuffer();
    r.ok ? stats.ok++ : stats.failed++;
  } catch {
    stats.failed++;
  }
  stats.totalMs += Date.now() - t0;
}

const end = Date.now() + minutes * 60_000;
const lookups = setInterval(() => hit(`/products/${1 + Math.floor(Math.random() * 10_000)}`), 333);
const searches = setInterval(() => hit(`/search?category=${pick(categories)}&q=${pick(terms)}`), 2000);
const report = setInterval(() => {
  const n = stats.ok + stats.failed;
  console.log(`${new Date().toISOString().slice(11, 19)}  requests=${n}  failed=${stats.failed}  avg=${n ? Math.round(stats.totalMs / n) : 0}ms`);
}, 10_000);

console.log(`sending traffic to ${base} for ${minutes} min…`);
setTimeout(() => {
  clearInterval(lookups);
  clearInterval(searches);
  clearInterval(report);
  console.log("done", stats);
}, end - Date.now());
