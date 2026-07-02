import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { PanelLeft, PanelLeftClose, Plus, Settings, ShieldCheck, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuthState } from "@/lib/auth/useAuthState";
import { threadKeys, threadsQueryOptions } from "@/lib/storage/threadQueries";
import { deleteThread } from "@/lib/storage/threads";
import type { ThreadSummary } from "@/lib/storage/types";
import { useInstanceSettings } from "@/lib/storage/useInstanceSettings";
import { cn } from "@/lib/utils";
import { UserMenu } from "./UserMenu";

/**
 * Collapsible chat-history sidebar. On `md+` it's a persistent column that collapses to a 48px icon rail
 * (expand + New chat) rather than hiding; below `md` it's an off-canvas overlay drawer with a backdrop that
 * hides fully when closed. Lists the viewer's threads (cheap summaries, no bodies) and links each to its
 * `/chat/$threadId` route. Reuses the `threads.ts` server fns — no DB code enters the client.
 *
 * The list is backed by TanStack Query, so chat creation/deletion can invalidate or update one shared cache
 * instead of relying on a one-off mount fetch. Storage is always on, so this is always shown.
 */
export function ChatSidebar({
  open,
  onToggle,
  onClose,
  onNewChat,
  onOpenSettings,
  onCreateWorkspace,
  activeThreadId,
}: {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onNewChat: () => void;
  onOpenSettings: () => void;
  onCreateWorkspace: () => void;
  activeThreadId?: string;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { instanceName } = useInstanceSettings();
  const { user } = useAuthState();
  const threadsQuery = useQuery(threadsQueryOptions);
  const threads = threadsQuery.data ?? [];

  // Selecting a thread should dismiss the overlay drawer on mobile, but leave the persistent desktop column
  // open. There's no matching desktop close-on-navigate, so this is viewport-gated rather than always-close.
  const closeOnMobile = () => {
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches) onClose();
  };

  const startNewChat = () => {
    closeOnMobile();
    onNewChat();
  };

  const openSettings = () => {
    closeOnMobile();
    onOpenSettings();
  };

  const createWorkspace = () => {
    closeOnMobile();
    onCreateWorkspace();
  };

  const remove = async (event: React.MouseEvent, id: string) => {
    // The delete control overlays the row's Link; keep the click from following it.
    event.preventDefault();
    event.stopPropagation();
    const previous = queryClient.getQueryData<ThreadSummary[]>(threadKeys.all);
    queryClient.setQueryData<ThreadSummary[]>(
      threadKeys.all,
      (current) => current?.filter((thread) => thread.id !== id) ?? [],
    );
    try {
      await deleteThread({ data: { threadId: id } });
      void queryClient.invalidateQueries({ queryKey: threadKeys.all });
    } catch {
      queryClient.setQueryData(threadKeys.all, previous);
    }
    // Deleting the open conversation would leave a dangling view — fall back to a fresh chat.
    if (id === activeThreadId) navigate({ to: "/" });
  };

  return (
    <>
      {open ? (
        <button
          type="button"
          aria-label="Close sidebar"
          onClick={onClose}
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
        />
      ) : null}
      <aside
        className={cn(
          "flex h-dvh w-[260px] shrink-0 flex-col border-r border-border bg-background transition-[width,transform] duration-200",
          // Desktop: never hides — full column when open, 48px icon rail when collapsed.
          open ? "md:w-[260px]" : "md:w-12",
          // Mobile: off-canvas overlay drawer that fully hides when closed.
          "max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:shadow-xl",
          open ? "max-md:translate-x-0" : "max-md:-translate-x-full",
        )}
      >
        {open ? (
          <>
            <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
              <div className="flex min-w-0 items-center gap-2">
                <BrandMark />
                {instanceName ? (
                  <span className="truncate text-base font-semibold tracking-tight">{instanceName}</span>
                ) : (
                  <span className="text-base font-semibold lowercase tracking-tight">ficta</span>
                )}
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" onClick={onToggle} aria-label="Collapse sidebar">
                    <PanelLeftClose className="size-4" aria-hidden />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Collapse</TooltipContent>
              </Tooltip>
            </div>

            {/* New chat is an action in the sidebar body, not the header — same standalone role it has in
                the collapsed rail. */}
            <div className="p-2 pb-0">
              <Button variant="outline" className="w-full justify-start gap-2" onClick={startNewChat}>
                <Plus className="size-4" aria-hidden />
                New chat
              </Button>
            </div>

            <nav className="flex-1 overflow-y-auto p-2">
              {threadsQuery.isPending ? (
                <p className="px-2 py-2 text-sm text-muted-foreground">Loading…</p>
              ) : threads.length === 0 ? (
                <p className="px-2 py-2 text-sm text-muted-foreground">No saved chats yet</p>
              ) : (
                <ul className="flex flex-col gap-0.5">
                  {threads.map((thread) => (
                    <li key={thread.id} className="group relative">
                      <Link
                        to="/chat/$threadId"
                        params={{ threadId: thread.id }}
                        onClick={closeOnMobile}
                        className={cn(
                          "flex items-center rounded-md py-1.5 pr-9 pl-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
                          thread.id === activeThreadId && "bg-accent text-accent-foreground",
                        )}
                      >
                        <span className="truncate">{thread.title}</span>
                      </Link>
                      <button
                        type="button"
                        aria-label="Delete chat"
                        onClick={(event) => remove(event, thread.id)}
                        className="absolute top-1/2 right-1 shrink-0 -translate-y-1/2 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                      >
                        <Trash2 className="size-3.5" aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </nav>

            {/* Account footer, pinned to the bottom by the flex-1 nav above. The menu opens upward. In
                `none` mode there's no user, so this is the app's Settings entry instead. */}
            <div className="shrink-0 border-t border-border p-2">
              {user ? (
                <UserMenu
                  user={user}
                  variant="row"
                  side="top"
                  align="start"
                  onOpenSettings={openSettings}
                  onCreateWorkspace={createWorkspace}
                />
              ) : (
                <Button
                  variant="ghost"
                  className="h-auto w-full justify-start gap-2 px-2 py-1.5"
                  onClick={openSettings}
                >
                  <Settings className="size-4" aria-hidden />
                  <span className="text-sm font-medium">Settings</span>
                </Button>
              )}
            </div>
          </>
        ) : (
          // Collapsed icon rail (desktop only — on mobile the whole aside is off-canvas).
          <>
            {/* Same h-14 header + divider as the expanded state, so the horizon line stays put. The brand
                mark is the expand control and swaps to an expand icon on hover. */}
            <div className="flex h-14 shrink-0 items-center justify-center border-b border-border">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={onToggle}
                    aria-label="Expand sidebar"
                    className="group flex size-7 items-center justify-center rounded-lg border border-border bg-secondary outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <ShieldCheck
                      className="size-4 text-emerald-600 group-hover:hidden dark:text-emerald-400"
                      aria-hidden
                    />
                    <PanelLeft className="hidden size-4 group-hover:block" aria-hidden />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">Expand</TooltipContent>
              </Tooltip>
            </div>
            <div className="flex flex-col items-center gap-2 py-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" onClick={startNewChat} aria-label="New chat">
                    <Plus className="size-4" aria-hidden />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">New chat</TooltipContent>
              </Tooltip>
            </div>

            {/* Account/settings pinned to the bottom of the rail. The avatar carries its own dropdown, so
                it isn't wrapped in a tooltip (that would fight the menu trigger for the same button). */}
            <div className="mt-auto flex flex-col items-center gap-2 pb-2">
              {user ? (
                <UserMenu
                  user={user}
                  variant="icon"
                  side="right"
                  align="end"
                  onOpenSettings={openSettings}
                  onCreateWorkspace={createWorkspace}
                />
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" onClick={openSettings} aria-label="Settings">
                      <Settings className="size-4" aria-hidden />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">Settings</TooltipContent>
                </Tooltip>
              )}
            </div>
          </>
        )}
      </aside>
    </>
  );
}

/** ficta's brand mark — the emerald protection shield, matching ProtectionBadge/EmptyState. Shown beside the
 * wordmark when expanded and alone (as the expand affordance) in the collapsed rail. */
function BrandMark() {
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary">
      <ShieldCheck className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
    </span>
  );
}
