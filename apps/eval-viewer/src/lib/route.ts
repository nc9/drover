// Trivial hash router: `#/` = index, `#/r/<runset>` = runset, `#/r/<runset>/<scenario>` = scenario.
import { useEffect, useState } from "react";

export type Route =
  | { name: "index" }
  | { name: "runset"; runset: string }
  | { name: "scenario"; runset: string; scenario: string }
  | { name: "storage" }
  | { name: "storage-run"; runId: string };

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, "").replace(/^\//, "");
  if (!path) return { name: "index" };
  const parts = path.split("/");
  if (parts[0] === "r" && parts[1]) {
    if (parts[2]) return { name: "scenario", runset: parts[1], scenario: parts[2] };
    return { name: "runset", runset: parts[1] };
  }
  if (parts[0] === "storage") {
    if (parts[1]) return { name: "storage-run", runId: parts[1] };
    return { name: "storage" };
  }
  return { name: "index" };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = (): void => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return (): void => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export function navigate(route: Route): void {
  window.location.hash = href(route);
}

export function href(route: Route): string {
  switch (route.name) {
    case "index":
      return "#/";
    case "runset":
      return `#/r/${route.runset}`;
    case "scenario":
      return `#/r/${route.runset}/${route.scenario}`;
    case "storage":
      return "#/storage";
    case "storage-run":
      return `#/storage/${route.runId}`;
  }
}
