import vinext from "vinext";
import { defineConfig, type Plugin } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";
const integrationNonce = process.env.JUNQI_INTEGRATION_NONCE;
const integrationListeningPlugin: Plugin | null =
  process.env.JUNQI_INTEGRATION_TEST === "1" &&
  typeof integrationNonce === "string" &&
  /^[0-9a-f]{32}$/.test(integrationNonce)
    ? {
        name: "junqi-integration-listening-ipc",
        configureServer(server) {
          const notifyParent = () => {
            const address = server.httpServer?.address();
            if (
              typeof process.send === "function" &&
              address &&
              typeof address === "object"
            ) {
              process.send({
                type: "junqi-integration-server-listening",
                nonce: integrationNonce,
                pid: process.pid,
                port: address.port,
              });
            }
          };
          if (server.httpServer?.listening) notifyParent();
          else server.httpServer?.once("listening", notifyParent);
        },
      }
    : null;

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");
  const integrationPersistence =
    process.env.JUNQI_INTEGRATION_TEST === "1"
      ? process.env.JUNQI_INTEGRATION_PERSIST_STATE
      : undefined;
  const persistState = integrationPersistence
    ? integrationPersistence === "memory"
      ? false
      : { path: integrationPersistence }
    : true;

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      sites(),
      integrationListeningPlugin,
      cloudflare({
        persistState,
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
