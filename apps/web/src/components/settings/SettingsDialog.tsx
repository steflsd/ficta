import { X } from "lucide-react";
import type * as React from "react";
import { useEffect, useState } from "react";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { isAdmin } from "@/lib/auth/types";
import { useAuthState } from "@/lib/auth/useAuthState";
import type { UserSettings } from "@/lib/storage/types";
import { useInstanceSettings } from "@/lib/storage/useInstanceSettings";
import { cn } from "@/lib/utils";
import { AdminSettingsForm } from "./AdminSettingsForm";
import { UserSettingsForm } from "./UserSettingsForm";

type SettingsTab = "preferences" | "admin";

/** Chat-style settings modal. Settings are an overlay on the current conversation, not a route/page. */
export function SettingsDialog({
  open,
  onOpenChange,
  userSettings,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userSettings?: UserSettings;
}) {
  const auth = useAuthState();
  const instanceSettings = useInstanceSettings();
  const admin = isAdmin(auth);
  const [tab, setTab] = useState<SettingsTab>("preferences");

  useEffect(() => {
    if (!admin && tab === "admin") setTab("preferences");
  }, [admin, tab]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="grid h-[min(640px,calc(100dvh-2rem))] max-w-[760px] grid-cols-[190px_minmax(0,1fr)] gap-0 overflow-hidden p-0 max-sm:h-[calc(100dvh-2rem)] max-sm:grid-cols-1"
      >
        <aside className="flex min-h-0 flex-col border-r border-border bg-muted/30 p-3 max-sm:border-r-0 max-sm:border-b">
          <DialogClose className="mb-3 flex size-9 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring">
            <X className="size-5" aria-hidden />
            <span className="sr-only">Close settings</span>
          </DialogClose>
          <nav className="space-y-1" aria-label="Settings sections">
            <SettingsTabButton active={tab === "preferences"} onClick={() => setTab("preferences")}>
              Preferences
            </SettingsTabButton>
            {admin ? (
              <SettingsTabButton active={tab === "admin"} onClick={() => setTab("admin")}>
                Admin
              </SettingsTabButton>
            ) : null}
          </nav>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-col">
          <header className="shrink-0 border-b border-border px-6 py-4">
            <DialogTitle className="text-xl">{tab === "admin" && admin ? "Admin" : "Preferences"}</DialogTitle>
            <DialogDescription className="sr-only">
              Manage your chat preferences{admin ? " and instance settings" : ""}.
            </DialogDescription>
          </header>

          <div className="min-h-0 overflow-y-auto px-6 py-1">
            {tab === "admin" && admin ? (
              <AdminSettingsForm settings={instanceSettings} />
            ) : (
              <UserSettingsForm settings={userSettings ?? {}} />
            )}
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}

function SettingsTabButton({ active, className, ...props }: React.ComponentProps<"button"> & { active: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        "flex h-9 w-full items-center rounded-lg px-3 text-left text-sm font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring",
        active && "bg-accent text-accent-foreground",
        className,
      )}
      {...props}
    />
  );
}
