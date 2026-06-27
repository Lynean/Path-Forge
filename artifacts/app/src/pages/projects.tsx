import { useState } from "react";
import { useLocation } from "wouter";
import { useListProjects, useCreateProject, useDeleteProject, getListProjectsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Loader2, ArrowRight, ArrowLeft, Trash2 } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface FramingQuestion {
  id: string;
  question: string;
  options: string[];
}

function buildEnrichedPrompt(
  base: string,
  questions: FramingQuestion[],
  answers: Record<string, string>
): string {
  const answered = questions.filter((q) => answers[q.id]);
  if (answered.length === 0) return base;
  const lines = answered.map((q) => `- ${q.question}: ${answers[q.id]}`).join("\n");
  return `${base}\n\nProject framing:\n${lines}`;
}

export default function Projects() {
  const [, setLocation] = useLocation();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"form" | "loading" | "framing" | "refining">("form");
  const [title, setTitle] = useState("");
  const [ideaPrompt, setIdeaPrompt] = useState("");
  const [framingQuestions, setFramingQuestions] = useState<FramingQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [otherSelected, setOtherSelected] = useState<Record<string, boolean>>({});

  const [deleteTargetId, setDeleteTargetId] = useState<number | null>(null);
  const queryClient = useQueryClient();
  const { data: projects, isLoading } = useListProjects();
  const createProject = useCreateProject();
  const deleteProject = useDeleteProject({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
        setDeleteTargetId(null);
      },
    },
  });

  const base = import.meta.env.BASE_URL.replace(/\/$/, "");

  const resetDialog = () => {
    setStep("form");
    setTitle("");
    setIdeaPrompt("");
    setFramingQuestions([]);
    setAnswers({});
    setOtherSelected({});
  };

  const handleOpenChange = (v: boolean) => {
    setOpen(v);
    if (!v) resetDialog();
  };

  const doCreate = (enrichedPrompt: string) => {
    createProject.mutate(
      { data: { title, ideaPrompt: enrichedPrompt } },
      {
        onSuccess: (project) => {
          setOpen(false);
          setLocation(`/projects/${project.id}`);
        },
      }
    );
  };

  const handleContinue = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !ideaPrompt.trim()) return;
    setStep("loading");
    try {
      const res = await fetch(`${base}/api/projects/frame-questions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, ideaPrompt }),
      });
      const data = (await res.json()) as { questions?: FramingQuestion[] };
      const questions = data.questions ?? [];
      if (questions.length === 0) throw new Error("no questions");
      setFramingQuestions(questions);
      setStep("framing");
    } catch {
      doCreate(ideaPrompt);
    }
  };

  const handleCreate = async () => {
    setStep("refining");
    const qa = framingQuestions
      .filter((q) => answers[q.id])
      .map((q) => ({ question: q.question, answer: answers[q.id] }));
    try {
      const res = await fetch(`${base}/api/projects/refine-description`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, ideaPrompt, qa }),
      });
      const data = (await res.json()) as { description?: string };
      doCreate(data.description ?? buildEnrichedPrompt(ideaPrompt, framingQuestions, answers));
    } catch {
      doCreate(buildEnrichedPrompt(ideaPrompt, framingQuestions, answers));
    }
  };

  const allAnswered =
    framingQuestions.length > 0 && framingQuestions.every((q) => answers[q.id]);

  return (
    <div className="p-6 md:p-10 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-3xl font-mono font-bold tracking-tight">Projects</h1>
        <Dialog open={open} onOpenChange={handleOpenChange}>
          <DialogTrigger asChild>
            <Button>New Project</Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[520px]">

            {/* ── Step 1: basic form ── */}
            {step === "form" && (
              <>
                <DialogHeader>
                  <DialogTitle>New Project</DialogTitle>
                  <DialogDescription>
                    Describe what you want to build. We'll ask a few questions to tailor your learning path.
                  </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleContinue} className="space-y-4 py-4">
                  <div className="space-y-2">
                    <Label htmlFor="title">Title</Label>
                    <Input
                      id="title"
                      placeholder="e.g. Custom React Renderer"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="ideaPrompt">What do you want to build?</Label>
                    <Textarea
                      id="ideaPrompt"
                      placeholder="I want to build a custom React renderer that outputs to a terminal..."
                      value={ideaPrompt}
                      onChange={(e) => setIdeaPrompt(e.target.value)}
                      className="min-h-[100px]"
                    />
                  </div>
                  <DialogFooter>
                    <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                      Cancel
                    </Button>
                    <Button type="submit" disabled={!title.trim() || !ideaPrompt.trim()}>
                      Next <ArrowRight className="w-3.5 h-3.5 ml-1.5" />
                    </Button>
                  </DialogFooter>
                </form>
              </>
            )}

            {/* ── Step 2: AI generating questions ── */}
            {step === "loading" && (
              <div className="py-14 flex flex-col items-center gap-4 text-center">
                <Loader2 className="w-7 h-7 animate-spin text-primary" />
                <div>
                  <p className="font-mono text-sm font-semibold">{title}</p>
                  <p className="text-xs text-muted-foreground mt-1">Framing your project...</p>
                </div>
              </div>
            )}

            {/* ── Step 3b: AI refining description ── */}
            {step === "refining" && (
              <div className="py-14 flex flex-col items-center gap-4 text-center">
                <Loader2 className="w-7 h-7 animate-spin text-primary" />
                <div>
                  <p className="font-mono text-sm font-semibold">{title}</p>
                  <p className="text-xs text-muted-foreground mt-1">Refining your project description...</p>
                </div>
              </div>
            )}

            {/* ── Step 3: MCQ framing ── */}
            {step === "framing" && (
              <>
                <DialogHeader>
                  <DialogTitle>A few quick questions</DialogTitle>
                  <DialogDescription>
                    Your answers will be appended to the project description to generate a better learning path.
                  </DialogDescription>
                </DialogHeader>

                <div className="py-4 space-y-6 max-h-[58vh] overflow-y-auto pr-1">
                  {framingQuestions.map((q, qi) => (
                    <div key={q.id} className="space-y-2.5">
                      <p className="text-sm font-medium leading-snug">
                        <span className="font-mono text-muted-foreground mr-2">{qi + 1}.</span>
                        {q.question}
                      </p>
                      <div className="space-y-1.5">
                        {q.options.map((opt) => (
                          <button
                            key={opt}
                            type="button"
                            onClick={() => {
                              setOtherSelected((prev) => ({ ...prev, [q.id]: false }));
                              setAnswers((prev) => ({ ...prev, [q.id]: opt }));
                            }}
                            className={cn(
                              "w-full text-left text-sm px-3.5 py-2.5 rounded-lg border transition-all",
                              answers[q.id] === opt && !otherSelected[q.id]
                                ? "border-primary bg-primary/10 text-foreground font-medium"
                                : "border-border text-muted-foreground hover:border-primary/40 hover:bg-muted/40 hover:text-foreground"
                            )}
                          >
                            {opt}
                          </button>
                        ))}
                        {/* Other option */}
                        <button
                          type="button"
                          onClick={() => {
                            setOtherSelected((prev) => ({ ...prev, [q.id]: true }));
                            setAnswers((prev) => ({ ...prev, [q.id]: "" }));
                          }}
                          className={cn(
                            "w-full text-left text-sm px-3.5 py-2.5 rounded-lg border transition-all",
                            otherSelected[q.id]
                              ? "border-primary bg-primary/10 text-foreground font-medium"
                              : "border-border text-muted-foreground hover:border-primary/40 hover:bg-muted/40 hover:text-foreground"
                          )}
                        >
                          Other...
                        </button>
                        {otherSelected[q.id] && (
                          <input
                            autoFocus
                            type="text"
                            value={answers[q.id] ?? ""}
                            onChange={(e) =>
                              setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))
                            }
                            placeholder="Describe your situation..."
                            className="w-full bg-input border border-primary/60 rounded-lg px-3.5 py-2.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                          />
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                {/* progress dots */}
                <div className="flex justify-center gap-1.5 pb-2">
                  {framingQuestions.map((q) => (
                    <div
                      key={q.id}
                      className={cn(
                        "w-1.5 h-1.5 rounded-full transition-colors",
                        answers[q.id] ? "bg-primary" : "bg-border"
                      )}
                    />
                  ))}
                </div>

                <DialogFooter className="flex items-center justify-between sm:justify-between gap-2 pt-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setStep("form")}
                    className="text-muted-foreground"
                  >
                    <ArrowLeft className="w-3.5 h-3.5 mr-1" /> Back
                  </Button>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => doCreate(ideaPrompt)}
                      disabled={createProject.isPending}
                    >
                      Skip
                    </Button>
                    <Button
                      type="button"
                      onClick={handleCreate}
                      disabled={!allAnswered || createProject.isPending}
                    >
                      {createProject.isPending ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <>
                          Create Project <ArrowRight className="w-3.5 h-3.5 ml-1.5" />
                        </>
                      )}
                    </Button>
                  </div>
                </DialogFooter>
              </>
            )}

          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="animate-pulse">
              <CardHeader className="h-24 bg-muted/50 rounded-t-xl" />
              <CardContent className="h-20" />
            </Card>
          ))}
        </div>
      ) : projects?.length === 0 ? (
        <div className="text-center py-20 border border-dashed rounded-xl bg-card">
          <p className="text-muted-foreground mb-4">No projects yet. Start by creating one.</p>
          <Button onClick={() => setOpen(true)} variant="outline">
            New Project
          </Button>
        </div>
      ) : (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {projects?.map((project) => (
            <Card key={project.id} className="flex flex-col">
              <CardHeader>
                <div className="flex items-start justify-between gap-4">
                  <CardTitle className="font-mono text-xl line-clamp-1">{project.title}</CardTitle>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Badge
                      variant={project.status === "completed" ? "default" : "secondary"}
                      className="uppercase text-[10px] tracking-wider"
                    >
                      {project.status}
                    </Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                      onClick={(e) => { e.stopPropagation(); setDeleteTargetId(project.id); }}
                      title="Delete project"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
                <TooltipProvider delayDuration={400}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <CardDescription className="line-clamp-2 mt-2 text-sm cursor-default">
                        {project.ideaPrompt}
                      </CardDescription>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-72 text-xs whitespace-pre-wrap">
                      {project.ideaPrompt}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </CardHeader>
              <CardContent className="flex-1">
                <div className="space-y-2 mt-auto">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Progress</span>
                    <span>--%</span>
                  </div>
                  <Progress value={0} className="h-1" />
                </div>
              </CardContent>
              <CardFooter>
                <Button
                  variant="secondary"
                  className="w-full"
                  onClick={() => setLocation(`/projects/${project.id}`)}
                >
                  Continue
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}

      <AlertDialog open={deleteTargetId !== null} onOpenChange={(v) => { if (!v) setDeleteTargetId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete project?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the project, its learning map, all chat history, and code context. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteProject.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTargetId !== null && deleteProject.mutate({ projectId: deleteTargetId })}
              disabled={deleteProject.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteProject.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
