import { useUser } from "@clerk/react";
import { isLocalMode } from "./localMode";

type OptionalUser = { user: { firstName?: string | null } | null };

// In fully-local mode there is no ClerkProvider, so Clerk's useUser() would
// throw. Bind to a stub that reports no user; cloud mode uses the real hook.
export const useOptionalUser: () => OptionalUser = isLocalMode
  ? () => ({ user: null })
  : (useUser as unknown as () => OptionalUser);
