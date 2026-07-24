import { useEffect, useState } from "preact/hooks";

export interface Route {
  view: string;
  params: Record<string, string>;
}

function parseHash(): Route {
  const hash = location.hash.slice(1) || "dashboard";
  const qsIdx = hash.indexOf("?");
  const path = qsIdx >= 0 ? hash.slice(0, qsIdx) : hash;
  const params: Record<string, string> = {};
  if (qsIdx >= 0) {
    const qs = hash.slice(qsIdx + 1);
    for (const part of qs.split("&")) {
      const eqIdx = part.indexOf("=");
      if (eqIdx >= 0) {
        params[decodeURIComponent(part.slice(0, eqIdx))] = decodeURIComponent(part.slice(eqIdx + 1));
      }
    }
  }
  return { view: path || "dashboard", params };
}

export function useRouter(): Route {
  const [route, setRoute] = useState<Route>(parseHash);

  useEffect(() => {
    const handler = () => setRoute(parseHash());
    addEventListener("hashchange", handler);
    return () => removeEventListener("hashchange", handler);
  }, []);

  return route;
}
