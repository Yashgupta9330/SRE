import { defineConfig } from "vitest/config";

// Unit tests run in Node: the tested modules (tools, providers, agent loop,
// memory) are plain TypeScript with Cloudflare bindings injected as interfaces.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node"
  }
});
