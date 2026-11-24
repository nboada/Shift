import { execSync } from "node:child_process";

// The roadmap is built from GitHub Issues carrying one of these labels. Only labelled issues are published,
// and only their titles: the repo is private, so bodies and links stay out of the site.
const REPO = "nboada/Shift";
export const STAGES = [
  { label: "roadmap: now", heading: "Now", note: "Being built" },
  { label: "roadmap: next", heading: "Next", note: "Up after that" },
  { label: "roadmap: later", heading: "Later", note: "Planned" },
] as const;

export interface Item {
  title: string;
  closedAt?: string;
}

function token(): string {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execSync("gh auth token", { encoding: "utf8" }).trim();
  } catch {
    throw new Error("The roadmap needs GitHub access: set GITHUB_TOKEN or sign in with `gh auth login`.");
  }
}

async function issues(label: string, state: "open" | "closed"): Promise<Item[]> {
  const url = `https://api.github.com/repos/${REPO}/issues?labels=${encodeURIComponent(label)}&state=${state}&per_page=100`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token()}`, accept: "application/vnd.github+json", "user-agent": "shift-site" },
  });
  if (!res.ok) throw new Error(`GitHub returned ${res.status} for the "${label}" issues.`);
  const list: { title: string; closed_at: string | null; pull_request?: unknown }[] = await res.json();
  return list.filter((i) => !i.pull_request).map((i) => ({ title: i.title, closedAt: i.closed_at ?? undefined }));
}

export async function loadRoadmap() {
  const stages = await Promise.all(STAGES.map(async (s) => ({ ...s, items: await issues(s.label, "open") })));
  const done = (await Promise.all(STAGES.map((s) => issues(s.label, "closed"))))
    .flat()
    .sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""))
    .slice(0, 8);
  return { stages, done };
}
