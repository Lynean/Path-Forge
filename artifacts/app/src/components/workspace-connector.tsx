import { useQueryClient } from "@tanstack/react-query";
import { FolderOpen, Loader2, Play, Eye } from "lucide-react";
import {
  useGetProjectWorkspace,
  useSetProjectWorkspace,
  useGetRuntimeCapabilities,
  getGetProjectWorkspaceQueryKey,
  getGetRuntimeCapabilitiesQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { getDesktopBridge } from "@/lib/desktop";

/**
 * Desktop-only control to attach the learner's real local project folder to a
 * project, so the tutor's agent can read and run the actual code. Uses the
 * Electron folder picker (native dialog) and persists the path via the API.
 * When a folder is attached, shows honestly whether code can run (Docker) or
 * whether the agent can only read files. Renders nothing in a normal browser.
 */
export function WorkspaceConnector({ projectId }: { projectId: number }) {
  const bridge = getDesktopBridge();
  const queryClient = useQueryClient();

  const { data: workspace } = useGetProjectWorkspace(projectId, {
    query: {
      enabled: !!projectId && !!bridge,
      retry: false,
      queryKey: getGetProjectWorkspaceQueryKey(projectId),
    },
  });

  const setWorkspace = useSetProjectWorkspace({
    mutation: {
      onSuccess: () =>
        queryClient.invalidateQueries({ queryKey: getGetProjectWorkspaceQueryKey(projectId) }),
    },
  });

  // Only check runtime capabilities once a folder is attached (the Docker
  // preflight is otherwise pointless and slow).
  const { data: caps } = useGetRuntimeCapabilities({
    query: {
      enabled: !!bridge && !!workspace?.path,
      retry: false,
      staleTime: 30_000,
      queryKey: getGetRuntimeCapabilitiesQueryKey(),
    },
  });

  if (!bridge) return null;

  const onConnect = async () => {
    const selection = await bridge.selectWorkspace();
    if (selection?.path) {
      setWorkspace.mutate({ projectId, data: { path: selection.path } });
    }
  };

  const folderName = workspace?.path
    ? workspace.path.split(/[\\/]/).filter(Boolean).pop()
    : null;

  return (
    <div className="flex flex-col items-end gap-0.5">
      <Button
        variant="outline"
        size="sm"
        onClick={onConnect}
        disabled={setWorkspace.isPending}
        className="font-mono text-xs h-8 px-2"
        title={workspace?.path ?? "Attach a local project folder so the tutor can read and run your code"}
      >
        {setWorkspace.isPending ? (
          <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
        ) : (
          <FolderOpen className="w-3.5 h-3.5 mr-1.5" />
        )}
        {folderName ? folderName : "Connect folder"}
      </Button>

      {workspace?.path && caps ? (
        caps.canRunCode ? (
          <span className="flex items-center gap-1 text-[10px] font-mono text-green-500">
            <Play className="w-2.5 h-2.5" /> can run code
          </span>
        ) : caps.canRunPython ? (
          <span
            className="flex items-center gap-1 text-[10px] font-mono text-sky-500 cursor-help"
            title={`Python runs in a built-in sandbox — no install needed. ${caps.dockerDetail} Install Docker for other languages and full projects.`}
          >
            <Play className="w-2.5 h-2.5" /> runs Python · Docker for more
          </span>
        ) : (
          <span
            className="flex items-center gap-1 text-[10px] font-mono text-amber-500 cursor-help"
            title={`${caps.dockerDetail} The tutor can still read your files.`}
          >
            <Eye className="w-2.5 h-2.5" /> reading only
          </span>
        )
      ) : null}
    </div>
  );
}
