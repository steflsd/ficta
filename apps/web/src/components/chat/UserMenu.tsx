import { LogOut, Plus, Settings } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { fetchOrganizations, switchOrganization } from "@/lib/auth/auth";
import type { AuthUser, OrgSummary } from "@/lib/auth/types";

type MenuSide = React.ComponentProps<typeof DropdownMenuContent>["side"];
type MenuAlign = React.ComponentProps<typeof DropdownMenuContent>["align"];

/**
 * Account control shown in the sidebar footer when hosted auth is on. Rendered only when there's a user,
 * so it simply doesn't appear in `none` mode. Sign-out is a top-level navigation to the sign-out server
 * route.
 *
 * When the user belongs to WorkOS organizations, a "Workspace" radio group lets them switch the active
 * one and create more. The list is lazy-loaded the first time the menu opens (one server call, then
 * cached), so it costs nothing on every navigation.
 *
 * `variant` picks the trigger: `row` is the full-width label used in the expanded sidebar footer; `icon`
 * is the avatar-only button used in the collapsed rail. `side`/`align` position the menu relative to the
 * trigger — the footer opens it upward.
 */
export function UserMenu({
  user,
  variant = "icon",
  side = "top",
  align = "start",
  onOpenSettings,
  onCreateWorkspace,
}: {
  user: AuthUser;
  variant?: "row" | "icon";
  side?: MenuSide;
  align?: MenuAlign;
  onOpenSettings: () => void;
  onCreateWorkspace: () => void;
}) {
  const label = user.name ?? user.email;
  const initial = label.trim().charAt(0).toUpperCase() || "?";
  const [orgs, setOrgs] = useState<OrgSummary[] | null>(null);

  // Load memberships once, on first open. Failures collapse to "no switcher" rather than blocking the menu.
  const onOpenChange = (open: boolean) => {
    if (open && orgs === null)
      fetchOrganizations()
        .then(setOrgs)
        .catch(() => setOrgs([]));
  };

  const handleSwitch = async (organizationId: string) => {
    if (organizationId === user.organizationId) return;
    await switchOrganization({ data: { organizationId } });
    // The active thread and settings belong to the old workspace, so re-derive everything from a clean load.
    window.location.assign("/");
  };

  const avatar = user.avatarUrl ? (
    <img src={user.avatarUrl} alt="" className="size-6 shrink-0 rounded-full object-cover" />
  ) : (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
      {initial}
    </span>
  );

  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        {variant === "row" ? (
          <Button variant="ghost" className="h-auto w-full justify-start gap-2 px-2 py-1.5" aria-label="Account">
            {avatar}
            <span className="truncate text-sm font-medium">{label}</span>
          </Button>
        ) : (
          <Button variant="ghost" size="icon" className="rounded-full" aria-label="Account">
            {avatar}
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent side={side} align={align} className="min-w-52">
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          {user.name ? <span className="truncate font-medium">{user.name}</span> : null}
          <span className="truncate text-xs font-normal text-muted-foreground">{user.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {orgs && orgs.length > 0 ? (
          <>
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Workspace</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={user.organizationId} onValueChange={handleSwitch}>
              {orgs.map((org) => (
                <DropdownMenuRadioItem key={org.id} value={org.id}>
                  <span className="truncate">{org.name}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuItem onSelect={onCreateWorkspace}>
              <Plus className="size-4" aria-hidden />
              Create workspace…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem onSelect={onOpenSettings}>
          <Settings className="size-4" aria-hidden />
          Settings
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onSelect={() => window.location.assign("/api/auth/sign-out")}>
          <LogOut className="size-4" aria-hidden />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
