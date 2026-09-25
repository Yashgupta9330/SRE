// Secrets are not in wrangler.jsonc, so `wrangler types` can't see them.
// Set with: npx wrangler secret put CF_API_TOKEN   (local dev: .dev.vars)
interface Env {
  CF_API_TOKEN?: string;
}
