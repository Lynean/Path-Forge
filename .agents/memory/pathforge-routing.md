---
name: PathForge split-view routing
description: How node detail routing works after the split-view refactor
---

# PathForge Split-View Routing

**After Task #3 refactor:**
- Both `/projects/:projectId` and `/projects/:projectId/nodes/:nodeId` route to `ProjectDetail` component.
- `NodeDetail` page (`node-detail.tsx`) still exists but is no longer routed — it's kept for reference only.
- `ProjectDetail` uses `useRoute` for both patterns and reads `nodeId` from the second pattern to show/hide the `NodeChatPanel` side panel.
- `NodeMapCanvas` accepts optional `onNodeClick` callback + `selectedNodeId` prop (selected node shows ring highlight).

**Why:** Split-view keeps the map visible while chatting; this is the core UX of PathForge.

**How to apply:**
- Never route to NodeDetail directly — use `/projects/:projectId/nodes/:nodeId` which opens the split view.
- When adding new node-level features, add them to `NodeChatPanel`, not `NodeDetail`.
