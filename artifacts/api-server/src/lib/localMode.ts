// Fully-local desktop mode: no Clerk, single on-device user. Enabled explicitly
// with PATHFORGE_LOCAL_MODE=1, or implicitly whenever the embedded local
// database is in use (PATHFORGE_LOCAL_DB), since that only happens on-device.
export const isLocalMode =
  process.env.PATHFORGE_LOCAL_MODE === "1" || Boolean(process.env.PATHFORGE_LOCAL_DB?.trim());

// The single local identity every DB row is scoped to when there is no login.
export const LOCAL_USER_ID = process.env.PATHFORGE_LOCAL_USER_ID?.trim() || "local-user";
