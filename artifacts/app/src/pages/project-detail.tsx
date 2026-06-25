import { useRoute } from "wouter";
import { useGetProject, useGetNodeMap, useGetProjectStats, getGetProjectQueryKey, getGetProjectStatsQueryKey, getGetNodeMapQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

export default function ProjectDetail() {
  const [match, params] = useRoute("/projects/:projectId");
  const projectId = match ? parseInt(params.projectId, 10) : 0;

  const { data: project, isLoading: projectLoading } = useGetProject(projectId, { query: { enabled: !!projectId, queryKey: getGetProjectQueryKey(projectId) } });
  const { data: stats } = useGetProjectStats(projectId, { query: { enabled: !!projectId, queryKey: getGetProjectStatsQueryKey(projectId) } });
  const { data: map, isLoading: mapLoading } = useGetNodeMap(projectId, { query: { enabled: !!projectId, queryKey: getGetNodeMapQueryKey(projectId) } });

  if (projectLoading) {
    return (
      <div className="p-6 md:p-10 max-w-6xl mx-auto space-y-6">
        <Skeleton className="h-10 w-1/3" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  if (!project) return null;

  return (
    <div className="p-6 md:p-10 max-w-6xl mx-auto flex flex-col h-full gap-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-3xl font-mono font-bold tracking-tight">{project.title}</h1>
            <Badge variant={project.status === 'completed' ? 'default' : 'secondary'} className="uppercase text-[10px] tracking-wider">
              {project.status}
            </Badge>
          </div>
          <p className="text-muted-foreground max-w-3xl">{project.ideaPrompt}</p>
        </div>
        {stats && (
          <div className="text-right flex flex-col items-end">
            <div className="text-3xl font-mono">{stats.progressPercent}%</div>
            <div className="text-xs text-muted-foreground uppercase tracking-wider">{stats.completedNodes} / {stats.totalNodes} Nodes</div>
          </div>
        )}
      </header>

      <div className="flex-1 min-h-[400px] border rounded-xl bg-card relative overflow-hidden flex flex-col">
        {mapLoading ? (
          <div className="flex items-center justify-center h-full w-full">
            <div className="animate-pulse flex flex-col items-center">
              <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin mb-4" />
              <p className="text-muted-foreground font-mono text-sm">Loading map...</p>
            </div>
          </div>
        ) : map?.nodes?.length ? (
          <div className="p-6 flex flex-col gap-4 overflow-y-auto h-full">
            {/* List representation of nodes for Task 1 */}
            {['available', 'locked', 'completed'].map(status => {
              const statusNodes = map.nodes.filter(n => n.status === status);
              if (!statusNodes.length) return null;
              return (
                <div key={status} className="space-y-3">
                  <h3 className="font-mono text-sm uppercase tracking-widest text-muted-foreground">{status}</h3>
                  <div className="grid gap-4 md:grid-cols-2">
                    {statusNodes.map(node => (
                      <Card key={node.id} className={`border ${node.status === 'completed' ? 'border-primary/50 bg-primary/5' : node.status === 'locked' ? 'opacity-50' : ''}`}>
                        <CardHeader className="py-3 px-4">
                          <CardTitle className="text-base font-mono">{node.title}</CardTitle>
                        </CardHeader>
                        <CardContent className="py-3 px-4 pt-0">
                          <p className="text-sm text-muted-foreground">{node.brief}</p>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-6">
            <div className="max-w-md space-y-4">
              <h3 className="text-xl font-bold font-mono">Map Not Generated</h3>
              <p className="text-muted-foreground">
                Generate your learning path to get started. The AI will break down your project idea into a sequence of actionable learning nodes.
              </p>
              <Button size="lg" className="font-mono mt-4">Generate Map</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
