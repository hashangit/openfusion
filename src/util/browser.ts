// Cross-platform "open this URL in the browser", guarded for headless/CI.
// Shared by the startup banner (index.ts, ui-only.ts) and the MCP tool's
// config-gate response (mcp-server.ts).

/** True when there's plausibly a GUI session to open a browser into. */
export function hasDisplay(): boolean {
  if (process.platform === "darwin") return true; // macOS always has a GUI session available
  if (process.env.DISPLAY) return true; // X11 (Linux)
  if (process.env.FORCE_OPEN) return true; // explicit override (also used by tests)
  // Windows: assume yes if running under a graphical session.
  return process.platform === "win32" && !!process.env.APPDATA;
}

/**
 * Open a URL in the user's default browser. Best-effort: never throws, never
 * blocks. Returns true if an open was *attempted* (not necessarily that a window
 * appeared). Silent no-op on headless systems unless FORCE_OPEN is set.
 */
export async function openDashboard(url = "http://localhost:9077"): Promise<boolean> {
  if (!hasDisplay()) return false;
  try {
    const open = (await import("open")).default;
    await open(url);
    return true;
  } catch {
    return false; // `open` missing or spawn failed — the URL is in the banner anyway.
  }
}
