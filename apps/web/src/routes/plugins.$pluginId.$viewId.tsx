import { createFileRoute, useCanGoBack, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, PuzzleIcon } from "lucide-react";
import { useCallback } from "react";

import { PluginUiPage } from "../components/plugins/PluginUi";
import { Button } from "../components/ui/button";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";

function PluginPageRoute() {
  const { pluginId, viewId } = Route.useParams();
  const canGoBack = useCanGoBack();
  const navigate = useNavigate();
  const back = useCallback(() => {
    if (canGoBack) window.history.back();
    else void navigate({ to: "/" });
  }, [canGoBack, navigate]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron}>
          <div className="flex min-w-0 items-center gap-2">
            <Button size="icon-sm" variant="ghost" aria-label="Back" onClick={back}>
              <ArrowLeftIcon />
            </Button>
            <PuzzleIcon className="size-4 text-muted-foreground" />
            <span className="truncate text-sm font-medium">{pluginId}</span>
          </div>
        </WorkspacePageHeader>
        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-4xl p-6">
            <PluginUiPage pluginId={pluginId} viewId={viewId} />
          </div>
        </main>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/plugins/$pluginId/$viewId")({
  component: PluginPageRoute,
});
