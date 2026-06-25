import { useState, useRef } from "react";
import { useRoute, useLocation } from "wouter";
import {
  useGetProject,
  useGetNodeMap,
  useGetProjectStats,
  useGenerateNodeMap,
  getGetProjectQueryKey,
  getGetProjectStatsQueryKey,
  getGetNodeMapQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { NodeMapCanvas } from "@/components/node-map-canvas";
import { NodeChatPanel } from "@/components/node-chat-panel";
import { Sparkles, RefreshCw, AlertCircle, ArrowLeft, PenLine, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export default function ProjectDetail() {
  const [matchExact, paramsExact] = useRoute("/projects/:projectId");
  const [matchNode, paramsNode] = useRoute("/projects/:projectId/nodes/:nodeId");

  const projectId = matchExact
    ? parseInt(paramsExact.projectId, 10)
    : matchNode
    ? parseInt(paramsNode.projectId, 10)
    : 0;

  const routeNodeId = matchNode ? parseInt(paramsNode.nodeId, 10) : null;

  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(routeNodeId);
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();

  const [showReviseModal, setShowReviseModal] = useState(false);
  const [reviseDescription, setReviseDescription] = useState("");
  const [isRevising, setIsRevising] = useState(false);
  const [reviseError, setReviseError] = useState<string | null>(null);

  const base = import.meta.env.BASE_URL.replace(/\/$/, "");

  const { data: project, isLoading: projectLoading } = useGetProject(projectId, {
    query: { enabled: !!projectId, queryKey: getGetProjectQueryKey(projectId) },
  });
  const { data: stats } = useGetProjectStats(projectId, {
    query: { enabled: !!projectId, queryKey: getGetProjectStatsQueryKey(projectId) },
  });
  const { data: map, isLoading: mapLoading, error: mapError } = useGetNodeMap(projectId, {
    query: { enabled: !!projectId, queryKey: getGetNodeMapQueryKey(projectId) },
  });

  const generateMap = useGenerateNodeMap({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetNodeMapQueryKey(projectId) });
        queryClient.invalidateQueries({ queryKey: getGetProjectStatsQueryKey(projectId) });
        queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
        handleClosePanel();
      },
    },
  });

  const handleNodeClick = (nodeId: number) => {
    setSelectedNodeId(nodeId);
    setLocation(`/projects/${projectId}/nodes/${nodeId}`);
  };

  const handleClosePanel = () => {
    setSelectedNodeId(null);
    setLocation(`/projects/${projectId}`);
  };

  const handleMapUpdate = () => {
    queryClient.invalidateQueries({ queryKey: getGetNodeMapQueryKey(projectId) });
    queryClient.invalidateQueries({ queryKey: getGetProjectStatsQueryKey(projectId) });
    queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
  };

  const handleRevisePlan = async () => {
    if (!reviseDescription.trim() || isRevising) return;
    setIsRevising(true);
    setReviseError(null);
    try {
      const res = await fetch(`${base}/api/projects/${projectId}/revise-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: reviseDescription.trim() }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Revision failed" }));
        setReviseError(err.error ?? "Revision failed");
        return;
      }
      queryClient.invalidateQueries({ queryKey: getGetNodeMapQueryKey(projectId) });
      queryClient.invalidateQueries({ queryKey: getGetProjectStatsQueryKey(projectId) });
      queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
      setReviseDescription("");
      setShowReviseModal(false);
      handleClosePanel();
    } catch {
      setReviseError("Network error. Please try again.");
    } finally {
      setIsRevising(false);
    }
  };

  if (projectLoading) {
    return (
      <div className="p-6 md:p-10 max-w-7xl mx-auto space-y-6">
        <Skeleton className="h-10 w-1/3" />
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-[60vh] w-full" />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="flex items-center justify-center h-full p-10">
        <div className="text-center space-y-3">
          <AlertCircle className="w-12 h-12 text-destructive mx-auto" />
          <p className="text-muted-foreground">Project not found.</p>
          <Button variant="outline" onClick={() => setLocation("/projects")}>
            Back to projects
          </Button>
        </div>
      </div>
    );
  }

  const hasMap = map && map.nodes && map.nodes.length > 0;
  const isGenerating = generateMap.isPending;
  const selectedNode = selectedNodeId !== null
    ? map?.nodes.find((n) => n.id === selectedNodeId) ?? null
    : null;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-4 md:px-6 pt-4 md:pt-6 pb-3 border-b border-border shrink-0">
        <div className="flex items-start justify-between gap-3 max-w-full">
          <div className="flex items-start gap-2 min-w-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setLocation("/projects")}
              className="h-7 w-7 p-0 shrink-0 text-muted-foreground hover:text-foreground mt-0.5"
            >
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <div className="min-w-0">
              <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                <h1
                  className="text-lg md:text-xl font-mono font-bold tracking-tight truncate"
                  data-testid="project-title"
                >
                  {project.title}
                </h1>
                <Badge
                  variant={project.status === "completed" ? "default" : "secondary"}
                  className="uppercase text-[10px] tracking-wider shrink-0"
                  data-testid="project-status"
                >
                  {project.status}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground max-w-xl line-clamp-1">
                {project.ideaPrompt}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {stats && hasMap && (
              <div className="text-right hidden sm:block">
                <div className="text-lg font-mono font-bold" data-testid="progress-percent">
                  {stats.progressPercent}%
                </div>
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider">
                  {stats.completedNodes}/{stats.totalNodes}
                </div>
              </div>
            )}
            {hasMap && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowReviseModal(true)}
                className="font-mono text-xs text-muted-foreground hover:text-foreground h-8 px-2"
                title="Revise learning plan"
                data-testid="button-revise-plan"
              >
                <PenLine className="w-3.5 h-3.5 mr-1.5" />
                Revise
              </Button>
            )}
            {hasMap ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => generateMap.mutate({ projectId })}
                disabled={isGenerating}
                data-testid="button-regenerate-map"
                className="font-mono text-xs h-8"
              >
                {isGenerating ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                    Generating...
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
                    Regenerate
                  </>
                )}
              </Button>
            ) : (
              <Button
                onClick={() => generateMap.mutate({ projectId })}
                disabled={isGenerating}
                data-testid="button-generate-map"
                className="font-mono text-xs h-8"
              >
                {isGenerating ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                    Generating...
                  </>
                ) : (
                  <>
                    <Sparkles className="w-3.5 h-3.5 mr-1.5" />
                    Generate Map
                  </>
                )}
              </Button>
            )}
          </div>
        </div>

        {stats && hasMap && (
          <div className="mt-2 w-full">
            <Progress value={stats.progressPercent} className="h-1" data-testid="progress-bar" />
          </div>
        )}
      </div>

      <div className="flex-1 flex overflow-hidden" data-testid="map-area">
        <div className={cn("relative overflow-hidden transition-all duration-300", selectedNode ? "flex-1 hidden md:block" : "flex-1")}>
          {isGenerating ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-background/80 backdrop-blur-sm z-10">
              <div className="w-10 h-10 border-4 border-primary border-t-transparent rounded-full animate-spin" />
              <div className="text-center space-y-1">
                <p className="font-mono font-semibold text-sm">Generating your learning path</p>
                <p className="text-xs text-muted-foreground">AI is personalizing your node map...</p>
              </div>
            </div>
          ) : null}

          {generateMap.error && !isGenerating ? (
            <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
              <div className="bg-destructive/10 border border-destructive/30 rounded-xl px-5 py-3 text-center max-w-sm">
                <AlertCircle className="w-7 h-7 text-destructive mx-auto mb-2" />
                <p className="text-sm font-mono text-destructive">Generation failed. Try again.</p>
              </div>
            </div>
          ) : null}

          {mapLoading && !isGenerating ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="w-7 h-7 border-4 border-primary border-t-transparent rounded-full animate-spin" />
            </div>
          ) : hasMap ? (
            <NodeMapCanvas
              apiNodes={map.nodes}
              apiEdges={map.edges}
              projectId={projectId}
              selectedNodeId={selectedNodeId}
              onNodeClick={handleNodeClick}
            />
          ) : !isGenerating ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-8">
              <div className="max-w-md space-y-4">
                <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto">
                  <Sparkles className="w-7 h-7 text-primary" />
                </div>
                <h3 className="text-xl font-bold font-mono">No learning path yet</h3>
                <p className="text-muted-foreground text-sm leading-relaxed">
                  Let AI analyze your project idea and generate a personalized learning node map.
                </p>
                <Button
                  size="lg"
                  onClick={() => generateMap.mutate({ projectId })}
                  disabled={isGenerating}
                  data-testid="button-generate-map-empty"
                  className="font-mono mt-2"
                >
                  <Sparkles className="w-4 h-4 mr-2" />
                  Generate Learning Path
                </Button>
              </div>
            </div>
          ) : null}
        </div>

        {selectedNode && (
          <div
            className={cn(
              "border-l border-border flex flex-col overflow-hidden",
              "w-full md:w-[420px] lg:w-[460px]"
            )}
            data-testid="chat-panel"
          >
            <NodeChatPanel
              key={selectedNode.id}
              projectId={projectId}
              node={selectedNode}
              onClose={handleClosePanel}
              onMapUpdate={handleMapUpdate}
            />
          </div>
        )}
      </div>

      <Dialog open={showReviseModal} onOpenChange={setShowReviseModal}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-mono">Revise Learning Plan</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground leading-relaxed">
              Describe how you'd like to change your learning direction. AI will rewrite future
              (not yet completed) nodes accordingly while keeping your progress.
            </p>
            <Textarea
              value={reviseDescription}
              onChange={(e) => setReviseDescription(e.target.value)}
              placeholder="E.g.: I want to focus more on backend performance and less on UI styling. Add topics on database indexing and caching..."
              rows={4}
              className="font-mono text-sm resize-none"
              data-testid="revise-description-input"
            />
            {reviseError && (
              <p className="text-xs text-destructive">{reviseError}</p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => { setShowReviseModal(false); setReviseError(null); }}
              disabled={isRevising}
            >
              Cancel
            </Button>
            <Button
              onClick={handleRevisePlan}
              disabled={!reviseDescription.trim() || isRevising}
              className="font-mono"
              data-testid="button-confirm-revise"
            >
              {isRevising ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Revising...
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4 mr-2" />
                  Revise Plan
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

