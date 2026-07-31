import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Server } from "node:http";

function repositoryRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

async function loadRootEnv(root: string): Promise<void> {
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return;
  const content = await readFile(envPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] ??= value;
  }
}

export async function startEmbeddedApi(): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
  mode: "byo" | "free" | "none";
}> {
  const root = repositoryRoot();
  await loadRootEnv(root);

  process.env.PATHFORGE_LOCAL_MODE = "1";
  process.env.PATHFORGE_LOCAL_DB ??= join(homedir(), "pathforge-cli-db");
  process.env.PATHFORGE_MIGRATIONS_DIR ??= join(root, "lib", "db", "drizzle");
  process.env.PATHFORGE_AGENT_HOME ??= join(homedir(), "pathforge-agent-home");
  process.env.LOG_LEVEL ??= "fatal";

  if (!process.env.OPENROUTER_API_KEY?.trim()) {
    process.env.PATHFORGE_PROXY_URL ??= "http://127.0.0.1:8080";
    process.env.PATHFORGE_DEVICE_ID ??= createHash("sha256")
      .update(`${hostname()}:${homedir()}`)
      .digest("hex")
      .slice(0, 24);
  }

  if (process.env.PATHFORGE_LOCAL_DB !== ":memory:") {
    await mkdir(process.env.PATHFORGE_LOCAL_DB, { recursive: true });
  }

  const dbUrl = pathToFileURL(join(root, "lib", "db", "src", "index.ts")).href;
  const { initLocalDatabase } = (await import(dbUrl)) as {
    initLocalDatabase: () => Promise<void>;
  };
  await initLocalDatabase();

  const appUrl = pathToFileURL(join(root, "artifacts", "api-server", "src", "app.ts")).href;
  const { default: app } = (await import(appUrl)) as {
    default: {
      listen: (
        port: number,
        host: string,
        callback: () => void,
      ) => Server;
    };
  };

  const server = await new Promise<Server>((resolveServer, reject) => {
    const instance = app.listen(0, "127.0.0.1", () => resolveServer(instance));
    instance.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not determine the embedded API port.");
  }

  const mode = process.env.OPENROUTER_API_KEY?.trim()
    ? "byo"
    : process.env.PATHFORGE_PROXY_URL && process.env.PATHFORGE_DEVICE_ID
      ? "free"
      : "none";

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    mode,
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      }),
  };
}
