import { Link, useLocation } from "wouter";
import { useUser, useClerk } from "@clerk/react";
import { Button } from "@/components/ui/button";

export function Layout({ children }: { children: React.ReactNode }) {
  const { user } = useUser();
  const { signOut } = useClerk();
  const [location] = useLocation();

  const isNavItemActive = (path: string) => location.startsWith(path);

  return (
    <div className="h-[100dvh] flex flex-col bg-background text-foreground overflow-hidden">
      <header className="sticky top-0 z-50 flex h-14 items-center gap-4 border-b border-border bg-background px-6">
        <Link href="/projects" className="flex items-center gap-2 font-mono font-bold text-lg tracking-tight">
          PathForge
        </Link>
        <nav className="flex items-center gap-6 mx-6 flex-1">
          <Link href="/projects" className={`text-sm font-medium transition-colors hover:text-primary ${isNavItemActive('/projects') ? 'text-foreground' : 'text-muted-foreground'}`}>
            Projects
          </Link>
          <Link href="/profile" className={`text-sm font-medium transition-colors hover:text-primary ${isNavItemActive('/profile') ? 'text-foreground' : 'text-muted-foreground'}`}>
            Profile
          </Link>
        </nav>
        <div className="flex items-center gap-4">
          <div className="text-sm text-muted-foreground font-mono">{user?.primaryEmailAddress?.emailAddress}</div>
          <Button variant="outline" size="sm" onClick={() => signOut({ redirectUrl: "/" })}>
            Log out
          </Button>
        </div>
      </header>
      <main className="flex-1 min-h-0 flex flex-col overflow-y-auto">{children}</main>
    </div>
  );
}
