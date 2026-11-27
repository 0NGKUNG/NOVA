const RECENT_PROJECTS_KEY = "nova_recent_project_paths";
const MAX_RECENT_PROJECTS = 4;

function normalizeRecentPaths(paths: unknown[]): string[] {
  const recent: string[] = [];
  for (const value of paths) {
    if (typeof value !== "string") continue;
    const path = value.trim();
    if (!path || recent.some((entry) => entry.toLowerCase() === path.toLowerCase())) continue;
    recent.push(path);
    if (recent.length === MAX_RECENT_PROJECTS) break;
  }
  return recent;
}

export function getRecentProjectPaths(): string[] {
  try {
    const value = localStorage.getItem(RECENT_PROJECTS_KEY);
    const parsed = value ? JSON.parse(value) : [];
    return Array.isArray(parsed) ? normalizeRecentPaths(parsed) : [];
  } catch {
    return [];
  }
}

export function rememberRecentProjectPath(path: string): string[] {
  const normalized = path.trim();
  if (!normalized) return getRecentProjectPaths();
  const recent = normalizeRecentPaths([normalized, ...getRecentProjectPaths()]);
  try {
    localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(recent));
  } catch {}
  return recent;
}

export function forgetRecentProjectPath(path: string): string[] {
  const recent = normalizeRecentPaths(getRecentProjectPaths().filter((entry) => entry.toLowerCase() !== path.toLowerCase()));
  try {
    localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(recent));
  } catch {}
  return recent;
}
