import {
  Binary,
  BrainCircuit,
  Cpu,
  Bot,
  Workflow,
  ShieldCheck,
  BarChart3,
  Network,
  FileText,
  Sigma,
  type LucideIcon,
} from "lucide-react";

// Mirrors the project-type categories the backend already uses for AI tutor pedagogy
// (see `detectProjectTypes` in aiNodeChat.ts / aiNodeMap.ts) so a recommendation's visual
// identity lines up with how the tutor will actually teach it.
export interface CategoryVisual {
  icon: LucideIcon;
  label: string;
  gradient: string;
  iconColor: string;
  glow: string;
}

export const CATEGORY_VISUALS: Record<string, CategoryVisual> = {
  algorithm: {
    icon: Binary,
    label: "Algorithms",
    gradient: "from-blue-500/20 via-blue-500/5 to-transparent",
    iconColor: "text-blue-400",
    glow: "group-hover:shadow-blue-500/20",
  },
  "math-impl": {
    icon: BrainCircuit,
    label: "AI / ML",
    gradient: "from-purple-500/20 via-purple-500/5 to-transparent",
    iconColor: "text-purple-400",
    glow: "group-hover:shadow-purple-500/20",
  },
  hardware: {
    icon: Cpu,
    label: "Hardware",
    gradient: "from-orange-500/20 via-orange-500/5 to-transparent",
    iconColor: "text-orange-400",
    glow: "group-hover:shadow-orange-500/20",
  },
  robotics: {
    icon: Bot,
    label: "Robotics",
    gradient: "from-emerald-500/20 via-emerald-500/5 to-transparent",
    iconColor: "text-emerald-400",
    glow: "group-hover:shadow-emerald-500/20",
  },
  "workflow-tools": {
    icon: Workflow,
    label: "Workflow Tools",
    gradient: "from-sky-500/20 via-sky-500/5 to-transparent",
    iconColor: "text-sky-400",
    glow: "group-hover:shadow-sky-500/20",
  },
  cybersecurity: {
    icon: ShieldCheck,
    label: "Cybersecurity",
    gradient: "from-red-500/20 via-red-500/5 to-transparent",
    iconColor: "text-red-400",
    glow: "group-hover:shadow-red-500/20",
  },
  "data-analytics": {
    icon: BarChart3,
    label: "Data Analytics",
    gradient: "from-indigo-500/20 via-indigo-500/5 to-transparent",
    iconColor: "text-indigo-400",
    glow: "group-hover:shadow-indigo-500/20",
  },
  "enterprise-integration": {
    icon: Network,
    label: "Integration",
    gradient: "from-teal-500/20 via-teal-500/5 to-transparent",
    iconColor: "text-teal-400",
    glow: "group-hover:shadow-teal-500/20",
  },
  "document-heavy": {
    icon: FileText,
    label: "Documentation",
    gradient: "from-slate-500/20 via-slate-500/5 to-transparent",
    iconColor: "text-slate-400",
    glow: "group-hover:shadow-slate-500/20",
  },
  theory: {
    icon: Sigma,
    label: "Theory",
    gradient: "from-pink-500/20 via-pink-500/5 to-transparent",
    iconColor: "text-pink-400",
    glow: "group-hover:shadow-pink-500/20",
  },
};

export const DEFAULT_CATEGORY_VISUAL: CategoryVisual = CATEGORY_VISUALS.theory;

export function getCategoryVisual(category: string | undefined | null): CategoryVisual {
  return (category && CATEGORY_VISUALS[category]) || DEFAULT_CATEGORY_VISUAL;
}
