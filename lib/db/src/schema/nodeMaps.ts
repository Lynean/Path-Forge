import { pgTable, serial, integer, timestamp, text, real, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const nodeMapsTable = pgTable("node_maps", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().unique(),
  rawJson: text("raw_json"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow().$onUpdate(() => new Date().toISOString()),
});

export const nodesTable = pgTable("nodes", {
  id: serial("id").primaryKey(),
  mapId: integer("map_id").notNull(),
  title: text("title").notNull(),
  brief: text("brief").notNull(),
  status: text("status").notNull().default("locked"),
  isExtra: boolean("is_extra").notNull().default(false),
  summary: text("summary"),
  positionX: real("position_x"),
  positionY: real("position_y"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow().$onUpdate(() => new Date().toISOString()),
});

export const nodeEdgesTable = pgTable("node_edges", {
  id: serial("id").primaryKey(),
  fromNodeId: integer("from_node_id").notNull(),
  toNodeId: integer("to_node_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

export const insertNodeMapSchema = createInsertSchema(nodeMapsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertNodeMap = z.infer<typeof insertNodeMapSchema>;
export type NodeMap = typeof nodeMapsTable.$inferSelect;

export const insertNodeSchema = createInsertSchema(nodesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertNode = z.infer<typeof insertNodeSchema>;
export type Node = typeof nodesTable.$inferSelect;

export const insertNodeEdgeSchema = createInsertSchema(nodeEdgesTable).omit({ id: true, createdAt: true });
export type InsertNodeEdge = z.infer<typeof insertNodeEdgeSchema>;
export type NodeEdge = typeof nodeEdgesTable.$inferSelect;
