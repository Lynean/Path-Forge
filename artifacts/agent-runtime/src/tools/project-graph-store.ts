import { buildProjectGraph, type ProjectGraph } from "../code-graph/project-graph";
import { WorkspaceAccess } from "../workspace/workspace-access";

/**
 * One harness composition should share one store between every graph tool.
 * The first graph operation builds the protected index; later search/parent
 * operations reuse the same in-memory promise.
 */
export class ProjectGraphStore {
  private graphPromise: Promise<ProjectGraph> | undefined;

  constructor(private readonly workspace: WorkspaceAccess) {}

  async get(): Promise<ProjectGraph> {
    const root = await this.workspace.root();
    this.graphPromise ??= buildProjectGraph(root, {
      readSource: (path) => this.workspace.readTextFile(path),
    });
    return await this.graphPromise;
  }
}
