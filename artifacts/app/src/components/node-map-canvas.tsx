import { useEffect, useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
  type NodeTypes,
  Handle,
  Position,
  MarkerType,
  useNodesState,
  useEdgesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useLocation } from "wouter";
import type { Node as ApiNode, NodeEdge } from "@workspace/api-client-react";
import { CheckCircle, Lock, Circle, Sparkles } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

interface NodeCardProps {
  data: {
    node: ApiNode;
    isSelected: boolean;
    onClick: () => void;
  };
}

function NodeCard({ data }: NodeCardProps) {
  const { node, onClick, isSelected } = data;
  const isAvailable = node.status === "available";
  const isCompleted = node.status === "completed";
  const isLocked = node.status === "locked";
  const isClickable = isAvailable || isCompleted;

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            onClick={isClickable ? onClick : undefined}
            data-testid={`node-card-${node.id}`}
            className={[
              "relative w-36 rounded-xl border px-3 py-2 transition-all duration-150 select-none",
              isSelected
                ? "bg-primary/15 border-primary shadow-xl shadow-primary/40 ring-1 ring-primary"
                : isAvailable
                ? "cursor-pointer bg-card border-primary/60 shadow-lg shadow-primary/10 hover:border-primary hover:shadow-xl hover:shadow-primary/50"
                : isCompleted
                ? "cursor-pointer bg-primary/10 border-primary/50 hover:border-primary/70 hover:shadow-lg hover:shadow-primary/30"
                : "cursor-default bg-muted/20 border-border/50 opacity-60 hover:opacity-80 hover:border-border hover:shadow-md",
            ].join(" ")}
          >
            <Handle
              type="target"
              position={Position.Top}
              className="!bg-border !border-border !w-2 !h-2"
            />

            <div className="flex items-start gap-2">
              <div className="mt-0.5 shrink-0">
                {isCompleted ? (
                  <CheckCircle className="w-4 h-4 text-primary" />
                ) : isAvailable ? (
                  <Circle className="w-4 h-4 text-primary/70" />
                ) : (
                  <Lock className="w-4 h-4 text-muted-foreground/50" />
                )}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-mono font-semibold leading-tight break-words">
                  {node.title}
                </p>
                {node.isExtra && (
                  <div className="flex items-center gap-0.5 mt-1">
                    <Sparkles className="w-2.5 h-2.5 text-primary/60" />
                    <span className="text-[10px] text-primary/60 font-mono">extra</span>
                  </div>
                )}
              </div>
            </div>

            <Handle
              type="source"
              position={Position.Bottom}
              className="!bg-border !border-border !w-2 !h-2"
            />
          </div>
        </TooltipTrigger>
        <TooltipContent side="left" className="max-w-64 space-y-1.5">
          <p className="font-mono font-semibold text-xs">{node.title}</p>
          <p className="text-xs text-muted-foreground leading-relaxed">
            {node.summary ?? node.brief}
          </p>
          {isLocked && (
            <p className="text-[10px] text-muted-foreground font-mono border-t border-border/40 pt-1 mt-0.5">
              Complete prerequisites to unlock
            </p>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

const nodeTypes: NodeTypes = { nodeCard: NodeCard };

function layoutNodes(
  apiNodes: ApiNode[],
  apiEdges: NodeEdge[]
): { nodes: Node[]; edges: Edge[] } {
  const edgeMap = new Map<number, number[]>();
  for (const edge of apiEdges) {
    if (!edgeMap.has(edge.fromNodeId)) edgeMap.set(edge.fromNodeId, []);
    edgeMap.get(edge.fromNodeId)!.push(edge.toNodeId);
  }

  const inDegree = new Map<number, number>(apiNodes.map((n) => [n.id, 0]));
  for (const edge of apiEdges) {
    inDegree.set(edge.toNodeId, (inDegree.get(edge.toNodeId) ?? 0) + 1);
  }

  const levels = new Map<number, number>();
  const queue: number[] = [];
  for (const [nodeId, deg] of inDegree) {
    if (deg === 0) {
      levels.set(nodeId, 0);
      queue.push(nodeId);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentLevel = levels.get(current) ?? 0;
    for (const successor of edgeMap.get(current) ?? []) {
      const newLevel = currentLevel + 1;
      if (!levels.has(successor) || levels.get(successor)! < newLevel) {
        levels.set(successor, newLevel);
      }
      const updatedLevel = levels.get(successor)!;
      if (!queue.includes(successor)) {
        queue.push(successor);
      }
      levels.set(successor, Math.max(updatedLevel, newLevel));
    }
  }

  const nodesByLevel = new Map<number, number[]>();
  for (const [nodeId, level] of levels) {
    if (!nodesByLevel.has(level)) nodesByLevel.set(level, []);
    nodesByLevel.get(level)!.push(nodeId);
  }

  const nodeIdToApiNode = new Map(apiNodes.map((n) => [n.id, n]));
  const HGAP = 240;
  const VGAP = 160;

  const flowNodes: Node[] = [];
  for (const [level, nodeIds] of nodesByLevel) {
    const totalWidth = (nodeIds.length - 1) * HGAP;
    nodeIds.forEach((nodeId, i) => {
      const apiNode = nodeIdToApiNode.get(nodeId);
      if (!apiNode) return;
      flowNodes.push({
        id: String(nodeId),
        type: "nodeCard",
        position: {
          x: i * HGAP - totalWidth / 2,
          y: level * VGAP,
        },
        data: { node: apiNode, isSelected: false, onClick: () => {} },
      });
    });
  }

  for (const apiNode of apiNodes) {
    if (!levels.has(apiNode.id)) {
      flowNodes.push({
        id: String(apiNode.id),
        type: "nodeCard",
        position: { x: 0, y: levels.size * VGAP },
        data: { node: apiNode, isSelected: false, onClick: () => {} },
      });
    }
  }

  const flowEdges: Edge[] = apiEdges.map((e) => {
    // A prerequisite being completed is what actually unlocks the path forward, so the
    // connection glows from the moment its source node is done — independent of whether
    // the target itself has been completed yet.
    const prerequisiteDone = nodeIdToApiNode.get(e.fromNodeId)?.status === "completed";

    return {
      id: `e${e.id}`,
      source: String(e.fromNodeId),
      target: String(e.toNodeId),
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: prerequisiteDone ? "hsl(var(--primary))" : "hsl(var(--border))",
        width: 14,
        height: 14,
      },
      style: prerequisiteDone
        ? {
            stroke: "hsl(var(--primary))",
            strokeWidth: 2,
            filter: "drop-shadow(0 0 6px hsl(var(--primary) / 0.9))",
          }
        : { stroke: "hsl(var(--border))", strokeWidth: 1.5 },
      animated: prerequisiteDone,
    };
  });

  return { nodes: flowNodes, edges: flowEdges };
}

interface NodeMapCanvasProps {
  apiNodes: ApiNode[];
  apiEdges: NodeEdge[];
  projectId: number;
  selectedNodeId?: number | null;
  onNodeClick?: (nodeId: number) => void;
}

export function NodeMapCanvas({
  apiNodes,
  apiEdges,
  projectId,
  selectedNodeId,
  onNodeClick,
}: NodeMapCanvasProps) {
  const [, setLocation] = useLocation();

  const { nodes: layoutedNodes, edges: layoutedEdges } = useMemo(
    () => layoutNodes(apiNodes, apiEdges),
    [apiNodes, apiEdges]
  );

  const nodesWithCallbacks = useMemo(
    () =>
      layoutedNodes.map((n) => ({
        ...n,
        data: {
          ...n.data,
          isSelected: selectedNodeId !== null && selectedNodeId !== undefined
            ? parseInt(n.id, 10) === selectedNodeId
            : false,
          onClick: () => {
            const apiNode = apiNodes.find((an) => an.id === parseInt(n.id, 10));
            if (apiNode && (apiNode.status === "available" || apiNode.status === "completed")) {
              if (onNodeClick) {
                onNodeClick(apiNode.id);
              } else {
                setLocation(`/projects/${projectId}/nodes/${n.id}`);
              }
            }
          },
        },
      })),
    [layoutedNodes, apiNodes, projectId, setLocation, onNodeClick, selectedNodeId]
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(nodesWithCallbacks);
  const [edges, setEdges, onEdgesChange] = useEdgesState(layoutedEdges);

  useEffect(() => {
    setNodes(nodesWithCallbacks);
  }, [nodesWithCallbacks, setNodes]);

  useEffect(() => {
    setEdges(layoutedEdges);
  }, [layoutedEdges, setEdges]);

  return (
    <div className="w-full h-full" data-testid="node-map-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.3}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        colorMode="dark"
        className="bg-background"
      >
        <Background color="hsl(var(--border))" gap={24} size={1} />
        <Controls
          className="[&>button]:bg-card [&>button]:border-border [&>button]:text-foreground [&>button:hover]:bg-secondary"
          showInteractive={false}
        />
      </ReactFlow>
    </div>
  );
}
