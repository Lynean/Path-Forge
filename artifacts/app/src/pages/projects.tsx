import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useListProjects, useCreateProject } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";

export default function Projects() {
  const [, setLocation] = useLocation();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [ideaPrompt, setIdeaPrompt] = useState("");

  const { data: projects, isLoading } = useListProjects();
  const createProject = useCreateProject();

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title || !ideaPrompt) return;
    createProject.mutate(
      { data: { title, ideaPrompt } },
      {
        onSuccess: (project) => {
          setOpen(false);
          setLocation(`/projects/${project.id}`);
        }
      }
    );
  };

  return (
    <div className="p-6 md:p-10 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-3xl font-mono font-bold tracking-tight">Projects</h1>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>New Project</Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[500px]">
            <DialogHeader>
              <DialogTitle>Create Project</DialogTitle>
              <DialogDescription>
                Describe what you want to build. We'll forge a learning path for you.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleCreate} className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="title">Title</Label>
                <Input id="title" placeholder="e.g. Custom React Renderer" value={title} onChange={(e) => setTitle(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ideaPrompt">Idea Description</Label>
                <Textarea 
                  id="ideaPrompt" 
                  placeholder="I want to build a custom React renderer from scratch that outputs to a terminal..."
                  value={ideaPrompt}
                  onChange={(e) => setIdeaPrompt(e.target.value)}
                  className="min-h-[100px]"
                />
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={!title || !ideaPrompt || createProject.isPending}>
                  {createProject.isPending ? "Creating..." : "Create"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map(i => (
            <Card key={i} className="animate-pulse">
              <CardHeader className="h-24 bg-muted/50 rounded-t-xl" />
              <CardContent className="h-20" />
            </Card>
          ))}
        </div>
      ) : projects?.length === 0 ? (
        <div className="text-center py-20 border border-dashed rounded-xl bg-card">
          <p className="text-muted-foreground mb-4">No projects yet. Start by creating one.</p>
          <Button onClick={() => setOpen(true)} variant="outline">New Project</Button>
        </div>
      ) : (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {projects?.map(project => (
            <Card key={project.id} className="flex flex-col">
              <CardHeader>
                <div className="flex items-start justify-between gap-4">
                  <CardTitle className="font-mono text-xl line-clamp-1">{project.title}</CardTitle>
                  <Badge variant={project.status === 'completed' ? 'default' : 'secondary'} className="uppercase text-[10px] tracking-wider">
                    {project.status}
                  </Badge>
                </div>
                <CardDescription className="line-clamp-2 mt-2 text-sm">{project.ideaPrompt}</CardDescription>
              </CardHeader>
              <CardContent className="flex-1">
                {/* Stats placeholder — in a real app, we might join this data or fetch it per card */}
                <div className="space-y-2 mt-auto">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Progress</span>
                    <span>--%</span>
                  </div>
                  <Progress value={0} className="h-1" />
                </div>
              </CardContent>
              <CardFooter>
                <Button variant="secondary" className="w-full" onClick={() => setLocation(`/projects/${project.id}`)}>
                  Continue
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
