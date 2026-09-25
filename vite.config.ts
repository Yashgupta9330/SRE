import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { defineConfig } from "vite";

// - agents(): TC39 decorator transform needed by @callable() (Vite 8's Oxc can't do it yet)
// - cloudflare(): runs worker/index.ts inside workerd during `vite dev`, and builds
//   the Worker + static assets for `wrangler deploy`
//
// Workers AI and Vectorize bindings are "remote" (they run on Cloudflare even
// in local dev) and need `wrangler login`. OFFLINE=1 disables them so the UI,
// Agent, Workflow and D1 can be exercised without an account; LLM calls then
// fail and the app shows its degraded/error paths.
export default defineConfig({
  plugins: [agents(), react(), cloudflare({ remoteBindings: process.env.OFFLINE !== "1" })]
});
