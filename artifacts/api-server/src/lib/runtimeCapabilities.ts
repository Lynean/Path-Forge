import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerSandbox, RuntimePolicy, createNodeRuntimePlan } from "@workspace/agent-runtime";

export interface RuntimeCapabilities {
  /** Whether a local Docker daemon is reachable and ready. */
  dockerAvailable: boolean;
  /** Human-readable detail (e.g. why Docker isn't available). */
  dockerDetail: string;
  /** Whether the learner can run code in a sandbox right now (today: Docker). */
  canRunCode: boolean;
}

// Preflight spawns the docker CLI; cache briefly so repeated UI polls are cheap.
const TTL_MS = 30_000;
let cached: { at: number; value: RuntimeCapabilities } | null = null;

export async function getRuntimeCapabilities(): Promise<RuntimeCapabilities> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;

  let dockerAvailable = false;
  let dockerDetail = "Docker is not available. Install Docker Desktop to run code.";
  try {
    const runtimePlan = new RuntimePolicy().requireApproved(createNodeRuntimePlan());
    const sandbox = new DockerSandbox({
      runtimePlan,
      dependencyCacheMetadataPath: join(tmpdir(), "pathforge-agent", "dependency-cache-usage.json"),
    });
    const status = await sandbox.preflight();
    dockerAvailable = status.ready;
    dockerDetail = status.message ?? (status.ready ? "Docker is ready." : dockerDetail);
  } catch (error) {
    dockerDetail = error instanceof Error ? error.message : "Docker check failed.";
  }

  const value: RuntimeCapabilities = { dockerAvailable, dockerDetail, canRunCode: dockerAvailable };
  cached = { at: Date.now(), value };
  return value;
}
