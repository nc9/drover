import { useRoute } from "./lib/route.ts";
import { IndexPage } from "./pages/index-page.tsx";
import { RunsetPage } from "./pages/runset-page.tsx";
import { ScenarioPage } from "./pages/scenario-page.tsx";
import { StoragePage } from "./pages/storage-page.tsx";
import { StorageRunPage } from "./pages/storage-run-page.tsx";

export function App(): React.ReactElement {
  const route = useRoute();
  switch (route.name) {
    case "index":
      return <IndexPage />;
    case "runset":
      return <RunsetPage runset={route.runset} />;
    case "scenario":
      return <ScenarioPage runset={route.runset} scenario={route.scenario} />;
    case "storage":
      return <StoragePage />;
    case "storage-run":
      return <StorageRunPage runId={route.runId} />;
  }
}
