// Shared by blog-draft and blog-publish (website blog posts from finished
// jobs - see BLOG_SETUP.md).

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Where the website (bingley-growth-plan) reads job posts from: see its
// client/src/data/jobPosts.ts.
export const CONTENT_DIR = "client/src/content/job-posts";
export const IMAGE_DIR = "client/public/images/blog/jobs";
export const IMAGE_URL_DIR = "/images/blog/jobs";

/** "Rusted Valley Iron — Castle Hill!" -> "rusted-valley-iron-castle-hill" */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "") || "job-write-up";
}

/** Removes em and en dashes, which read as AI-written (same rule as Google posts). */
export function cleanText(text: string): string {
  return text.replace(/\s*[—–]\s*/g, ", ").replace(/,\s*,/g, ",").replace(/\n{3,}/g, "\n\n").trim();
}

/** Width and height of a JPEG, from its SOF marker; null if it can't tell. */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = bytes[i + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const length = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    // SOF0-SOF15, except DHT (C4), JPG (C8) and DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (bytes[i + 5]! << 8) | bytes[i + 6]!, width: (bytes[i + 7]! << 8) | bytes[i + 8]! };
    }
    i += 2 + length;
  }
  return null;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

export interface PostPhotoRow {
  job_file_id: string | null;
  url: string; // public marketing copy
  alt: string;
}
export interface BlogPostRow {
  id: string;
  slug: string;
  title: string;
  description: string;
  body: string;
  suburb: string | null;
  job_type: string | null;
  photos: PostPhotoRow[];
  cta: { heading?: string; text?: string; button?: string } | null;
}

// --- GitHub ------------------------------------------------------------------

export class GitHubError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export function github(token: string, apiBase = "https://api.github.com") {
  return async function call<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "jms-blog-publish",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      let message = text.slice(0, 300);
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? message;
      } catch {
        /* not JSON */
      }
      throw new GitHubError(`GitHub ${res.status} on ${path.replace(/\?.*$/, "")}: ${message}`, res.status);
    }
    return (res.status === 204 ? {} : await res.json()) as T;
  };
}

/** Whether a file exists in the repo at the given ref. */
async function exists(call: ReturnType<typeof github>, repo: string, path: string, ref: string): Promise<boolean> {
  try {
    await call("GET", `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`);
    return true;
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) return false;
    throw e;
  }
}

/**
 * Commits the post (its data file, its /blog card and its photos) to the
 * website repository in one commit, then moves the branch to it. Picks a
 * free slug if the post's own is already a page on the site. Returns the
 * slug used and the commit.
 */
export async function commitPost(opts: {
  token: string;
  repo: string;
  branch: string;
  post: BlogPostRow;
  publishDate: string; // YYYY-MM-DD
  apiBase?: string;
}): Promise<{ slug: string; commitSha: string }> {
  const call = github(opts.token, opts.apiBase);
  const { repo, branch, post } = opts;

  // Photos first: they don't depend on the slug's folder name until the tree.
  const photos: { bytes: Uint8Array; alt: string }[] = [];
  for (const p of post.photos) {
    const res = await fetch(p.url);
    if (!res.ok) throw new Error(`Couldn't download a photo (${res.status}): ${p.url}`);
    photos.push({ bytes: new Uint8Array(await res.arrayBuffer()), alt: p.alt });
  }

  // Retry once if someone else pushed between reading and moving the branch.
  for (let attempt = 0; ; attempt++) {
    const ref = await call<{ object: { sha: string } }>("GET", `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
    const headSha = ref.object.sha;
    const head = await call<{ tree: { sha: string } }>("GET", `/repos/${repo}/git/commits/${headSha}`);

    // A slug that isn't already a page: neither a job post nor a hand-written
    // post route in App.tsx.
    const app = await call<{ content: string }>("GET", `/repos/${repo}/contents/client/src/App.tsx?ref=${headSha}`);
    const appSource = atob(app.content.replace(/\n/g, ""));
    let slug = post.slug;
    for (let n = 2; ; n++) {
      const taken = appSource.includes(`"/blog/${slug}"`) || (await exists(call, repo, `${CONTENT_DIR}/${slug}.json`, headSha));
      if (!taken) break;
      if (n > 20) throw new Error("Couldn't find a free address for this post");
      slug = `${post.slug.slice(0, 80)}-${n}`;
    }

    const tree: { path: string; mode: string; type: string; sha: string }[] = [];
    const photoMeta: { src: string; alt: string; width?: number; height?: number }[] = [];
    for (let i = 0; i < photos.length; i++) {
      const blob = await call<{ sha: string }>("POST", `/repos/${repo}/git/blobs`, { content: toBase64(photos[i]!.bytes), encoding: "base64" });
      const name = `${i + 1}.jpg`;
      tree.push({ path: `${IMAGE_DIR}/${slug}/${name}`, mode: "100644", type: "blob", sha: blob.sha });
      const size = jpegSize(photos[i]!.bytes);
      photoMeta.push({ src: `${IMAGE_URL_DIR}/${slug}/${name}`, alt: photos[i]!.alt, ...(size ?? {}) });
    }
    const data = {
      slug,
      title: post.title,
      description: post.description,
      publishDate: opts.publishDate,
      suburb: post.suburb,
      service: post.job_type,
      category: "Case Study",
      photos: photoMeta,
      body: post.body,
      ...(post.cta ? { cta: post.cta } : {}),
    };
    const card = {
      title: post.title,
      description: post.description,
      publishDate: opts.publishDate,
      suburb: post.suburb,
      category: "Case Study",
      ...(photoMeta[0] ? { image: photoMeta[0].src } : {}),
    };
    for (const [path, content] of [
      [`${CONTENT_DIR}/${slug}.json`, JSON.stringify(data, null, 2) + "\n"],
      [`${CONTENT_DIR}/cards/${slug}.json`, JSON.stringify(card, null, 2) + "\n"],
    ] as const) {
      const blob = await call<{ sha: string }>("POST", `/repos/${repo}/git/blobs`, { content, encoding: "utf-8" });
      tree.push({ path, mode: "100644", type: "blob", sha: blob.sha });
    }

    const newTree = await call<{ sha: string }>("POST", `/repos/${repo}/git/trees`, { base_tree: head.tree.sha, tree });
    const commit = await call<{ sha: string }>("POST", `/repos/${repo}/git/commits`, {
      message: `Blog: ${post.title}\n\nJob write-up published from JMS.`,
      tree: newTree.sha,
      parents: [headSha],
    });
    try {
      await call("PATCH", `/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { sha: commit.sha, force: false });
      return { slug, commitSha: commit.sha };
    } catch (e) {
      // 422: the branch moved on (not a fast-forward any more). Start again.
      if (e instanceof GitHubError && e.status === 422 && attempt === 0) continue;
      throw e;
    }
  }
}
