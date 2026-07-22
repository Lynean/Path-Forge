import { useQueryClient } from "@tanstack/react-query";
import { FolderOpen, Loader2 } from "lucide-react";
import {
  useGetProjectWorkspace,
  useSetProjectWorkspace,
  getGetProjectWorkspaceQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { getDesktopBridge } from "@/lib/desktop";

/**
 * Desktop-only control to attach the learner's real local project folder to a
 * project, so the tutor's agent can read and run the actual code. Uses the
 * Electron folder picker (native dialog) and persists the path via the API.
 * Renders nothing in a normal browser.
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
  );
}
