import { Link, useLocation } from "wouter";

/**
 * Clerk-free app shell for fully-local desktop mode. Same header as {@link Layout}
 * but with no user account / sign-out (there is a single on-device user), so it
 * never touches Clerk hooks that require a ClerkProvider.
 */
export function LocalLayout({ children }: { children: React.ReactNode }) {
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
        <div className="text-sm text-muted-foreground font-mono">Local</div>
      </header>
      <main className="flex-1 min-h-0 flex flex-col overflow-y-auto">{children}</main>
    </div>
  );
}
