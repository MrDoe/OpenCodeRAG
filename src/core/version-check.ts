export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseUrl: string;
  publishedAt: string;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((s) => parseInt(s, 10));
  const pb = b.split(".").map((s) => parseInt(s, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

export async function checkForUpdate(currentVersion: string): Promise<UpdateInfo> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);

  try {
    const response = await fetch("https://api.github.com/repos/MrDoe/OpenCodeRAG/releases/latest", {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "opencode-rag-updater",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      return { currentVersion, latestVersion: currentVersion, updateAvailable: false, releaseUrl: "", publishedAt: "" };
    }

    const data = (await response.json()) as { tag_name?: string; html_url?: string; published_at?: string };
    const tagName = data.tag_name;
    if (!tagName) {
      return { currentVersion, latestVersion: currentVersion, updateAvailable: false, releaseUrl: "", publishedAt: "" };
    }

    const latestVersion = tagName.replace(/^v/i, "");
    return {
      currentVersion,
      latestVersion,
      updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
      releaseUrl: data.html_url ?? "",
      publishedAt: data.published_at ?? "",
    };
  } catch {
    return { currentVersion, latestVersion: currentVersion, updateAvailable: false, releaseUrl: "", publishedAt: "" };
  } finally {
    clearTimeout(timeout);
  }
}
