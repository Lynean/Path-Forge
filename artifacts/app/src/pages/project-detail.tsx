import { useState } from "react";
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
import { NodeMapCanvas } from "@/components/node-map-canvas";
import { Sparkles, RefreshCw, AlertCircle } from "lucide-react";

export default function ProjectDetail() {
  const [match, params] = useRoute("/projects/:projectId");
  const projectId = match ? parseInt(params.projectId, 10) : 0;
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();

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
      },
    },
  });

  const handleGenerate = () => {
    generateMap.mutate({ projectId });
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

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-6 md:px-10 pt-6 md:pt-8 pb-4 border-b border-border shrink-0">
        <div className="flex items-start justify-between gap-4 max-w-7xl mx-auto">
          <div className="min-w-0">
            <div className="flex items-center gap-3 mb-1.5">
              <h1
                className="text-2xl font-mono font-bold tracking-tight truncate"
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
            <p className="text-sm text-muted-foreground max-w-2xl line-clamp-2">
              {project.ideaPrompt}
            </p>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {stats && hasMap && (
              <div className="text-right hidden sm:block">
                <div className="text-2xl font-mono font-bold" data-testid="progress-percent">
                  {stats.progressPercent}%
                </div>
                <div className="text-xs text-muted-foreground uppercase tracking-wider">
                  {stats.completedNodes} / {stats.totalNodes} nodes
                </div>
              </div>
            )}
            {hasMap ? (
              <Button
                variant="outline"
                size="sm"
                onClick={handleGenerate}
                disabled={isGenerating}
                data-testid="button-regenerate-map"
                className="font-mono"
              >
                {isGenerating ? (
                  <>
                    <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                    Generating...
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-4 h-4 mr-2" />
                    Regenerate
                  </>
                )}
              </Button>
            ) : (
              <Button
                onClick={handleGenerate}
                disabled={isGenerating}
                data-testid="button-generate-map"
                className="font-mono"
              >
                {isGenerating ? (
                  <>
                    <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                    Generating...
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4 mr-2" />
                    Generate Map
                  </>
                )}
              </Button>
            )}
          </div>
        </div>

        {stats && hasMap && (
          <div className="mt-3 max-w-7xl mx-auto">
            <Progress
              value={stats.progressPercent}
              className="h-1.5"
              data-testid="progress-bar"
            />
          </div>
        )}
      </div>

      <div className="flex-1 relative overflow-hidden" data-testid="map-area">
        {isGenerating ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-background/80 backdrop-blur-sm z-10">
            <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin" />
            <div className="text-center space-y-1">
              <p className="font-mono font-semibold">Generating your learning path</p>
              <p className="text-sm text-muted-foreground">
                AI is personalizing your node map...
              </p>
            </div>
          </div>
        ) : null}

        {generateMap.error && !isGenerating ? (
          <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
            <div className="bg-destructive/10 border border-destructive/30 rounded-xl px-6 py-4 text-center max-w-sm">
              <AlertCircle className="w-8 h-8 text-destructive mx-auto mb-2" />
              <p className="text-sm font-mono text-destructive">
                Generation failed. Try again.
              </p>
            </div>
          </div>
        ) : null}

        {mapLoading && !isGenerating ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        ) : hasMap ? (
          <NodeMapCanvas
            apiNodes={map.nodes}
            apiEdges={map.edges}
            projectId={projectId}
          />
        ) : !isGenerating ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-8">
            <div className="max-w-md space-y-4">
              <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto">
                <Sparkles className="w-8 h-8 text-primary" />
              </div>
              <h3 className="text-xl font-bold font-mono">No learning path yet</h3>
              <p className="text-muted-foreground text-sm leading-relaxed">
                Let the AI analyze your project idea and generate a personalized node
                map — a sequence of learning steps tailored to your background.
              </p>
              <Button
                size="lg"
                onClick={handleGenerate}
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
    </div>
  );
}
