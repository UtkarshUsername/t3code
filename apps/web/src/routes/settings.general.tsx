import { RotateCcwIcon } from "lucide-react";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { GeneralSettingsPanel, useSettingsRestore } from "../components/settings/SettingsPanels";
import { Button } from "../components/ui/button";

function GeneralSettingsRoute() {
  const [restoreSignal, setRestoreSignal] = useState(0);
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore(() =>
    setRestoreSignal((value) => value + 1),
  );

  return (
    <GeneralSettingsPanel
      key={restoreSignal}
      headerAction={
        <Button
          size="xs"
          variant="outline"
          disabled={changedSettingLabels.length === 0}
          onClick={() => void restoreDefaults()}
        >
          <RotateCcwIcon className="size-3.5" />
          Restore defaults
        </Button>
      }
    />
  );
}

export const Route = createFileRoute("/settings/general")({
  component: GeneralSettingsRoute,
});
