import { createFileRoute, redirect, useCanGoBack, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, PuzzleIcon } from "lucide-react";
import { useCallback, useMemo } from "react";

import { PluginUiPage, usePluginUiCatalog } from "../components/plugins/PluginUi";
import { Button } from "../components/ui/button";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { WorkspacePageContainer } from "../components/WorkspacePageContainer";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../components/WorkspaceBreadcrumb";
import { ScrollArea } from "../components/ui/scroll-area";
import { isElectron } from "../env";
import { usePrimaryEnvironmentId } from "../state/environments";

function PluginPageRoute() {
  const { pluginId, viewId } = Route.useParams();
  const environmentId = usePrimaryEnvironmentId();
  const catalog = usePluginUiCatalog(environmentId);
  const viewLabel = useMemo(() => {
    const currentSurface = isElectron ? "desktop" : "web";
    const pluginPackage = catalog.packages.find((candidate) => candidate.pluginId === pluginId);
    return pluginPackage?.views.find(
      (candidate) => candidate.id === viewId && candidate.surfaces.includes(currentSurface),
    )?.label;
  }, [catalog.packages, pluginId, viewId]);
  const canGoBack = useCanGoBack();
  const navigate = useNavigate();
  const back = useCallback(() => {
    if (canGoBack) window.history.back();
    else void navigate({ to: "/" });
  }, [canGoBack, navigate]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron}>
          <div className="flex min-w-0 items-center gap-2">
            <Button size="icon-sm" variant="ghost" aria-label="Back" onClick={back}>
              <ArrowLeftIcon />
            </Button>
            <PuzzleIcon className="size-4 text-muted-foreground" />
            <WorkspaceBreadcrumb ariaLabel="Plugin breadcrumb" className="min-w-0">
              <WorkspaceBreadcrumbItem current className="truncate">
                {viewLabel ?? pluginId}
              </WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
          </div>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1" scrollFade scrollbarGutter>
          <WorkspacePageContainer width="wide">
            <PluginUiPage pluginId={pluginId} viewId={viewId} />
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/plugins/$pluginId/$viewId")({
  beforeLoad: ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: PluginPageRoute,
});
