import {
  useGetProjectRecommendations,
  useRegenerateProjectRecommendations,
  getGetProjectRecommendationsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Sparkles, RefreshCw, ArrowRight } from "lucide-react";
import { getCategoryVisual } from "@/lib/project-category-visuals";
import { cn } from "@/lib/utils";

interface ProjectRecommendationsProps {
  onSelect: (title: string, description: string) => void;
}

export function ProjectRecommendations({ onSelect }: ProjectRecommendationsProps) {
  const queryClient = useQueryClient();

  // Persisted server-side — the same 10 ideas are returned on every visit until the
  // learner explicitly regenerates them, so no client-side staleTime tricks are needed.
  const { data, isLoading, isError, refetch } = useGetProjectRecommendations({
    query: { queryKey: getGetProjectRecommendationsQueryKey(), retry: false },
  });

  const regenerate = useRegenerateProjectRecommendations({
    mutation: {
      onSuccess: (result) => {
        queryClient.setQueryData(getGetProjectRecommendationsQueryKey(), result);
      },
    },
  });

  const recommendations = data?.recommendations ?? [];

  if (isError) {
    return (
      <div className="mb-10 flex items-center justify-between rounded-xl border border-dashed border-border bg-card/50 px-5 py-4">
        <p className="text-sm text-muted-foreground">Couldn't load project ideas right now.</p>
        <Button size="sm" variant="outline" onClick={() => refetch()}>
          <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="mb-10">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-primary" />
          <h2 className="text-lg font-mono font-bold tracking-tight">Recommended for you</h2>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => regenerate.mutate()}
          disabled={isLoading || regenerate.isPending}
          className="text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className={cn("w-3.5 h-3.5 mr-1.5", regenerate.isPending && "animate-spin")} />
          New ideas
        </Button>
      </div>

      <div className="flex gap-4 overflow-x-auto pb-3 -mx-1 px-1 snap-x">
        {isLoading || regenerate.isPending
          ? Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="w-64 shrink-0 rounded-xl border border-border bg-card p-4 space-y-3">
                <Skeleton className="w-9 h-9 rounded-lg" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            ))
          : recommendations.map((rec, i) => {
              const visual = getCategoryVisual(rec.category);
              const Icon = visual.icon;
              return (
                <button
                  key={`${rec.title}-${i}`}
                  onClick={() => onSelect(rec.title, rec.description)}
                  className={cn(
                    "group relative w-64 shrink-0 snap-start text-left rounded-xl border border-border bg-card p-4 overflow-hidden",
                    "transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-lg",
                    visual.glow
                  )}
                >
                  <div className={cn("absolute inset-0 bg-gradient-to-br opacity-60 pointer-events-none", visual.gradient)} />
                  <div className="relative">
                    <div className="flex items-center justify-between mb-3">
                      <div className={cn("w-9 h-9 rounded-lg bg-background/80 border border-border/50 flex items-center justify-center", visual.iconColor)}>
                        <Icon className="w-4.5 h-4.5" />
                      </div>
                      <span className={cn("text-[10px] font-mono uppercase tracking-wider", visual.iconColor)}>
                        {visual.label}
                      </span>
                    </div>
                    <p className="font-mono font-semibold text-sm leading-snug mb-1.5 line-clamp-2">
                      {rec.title}
                    </p>
                    <p className="text-xs text-muted-foreground leading-relaxed line-clamp-3 mb-3">
                      {rec.description}
                    </p>
                    <div className="flex items-center gap-1 text-xs font-medium text-primary opacity-0 group-hover:opacity-100 transition-opacity">
                      Start building <ArrowRight className="w-3 h-3" />
                    </div>
                  </div>
                </button>
              );
            })}
      </div>
    </div>
  );
}
