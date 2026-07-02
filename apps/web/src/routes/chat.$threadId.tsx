import { createFileRoute, redirect } from "@tanstack/react-router";
import { ChatView } from "@/components/chat/ChatView";
import { storedToUi } from "@/lib/storage/messages";
import { fetchUserSettings } from "@/lib/storage/settings";
import { fetchThread } from "@/lib/storage/threads";

/**
 * A saved conversation. The loader hydrates it (and the viewer's settings for the model default); an
 * unknown or not-owned id resolves to null → redirect to a fresh chat. ChatView then keeps saving
 * snapshots to this same thread id as the conversation continues.
 */
export const Route = createFileRoute("/chat/$threadId")({
  loader: async ({ params }) => {
    const [thread, userSettings] = await Promise.all([
      fetchThread({ data: { threadId: params.threadId } }),
      fetchUserSettings(),
    ]);
    if (!thread) throw redirect({ to: "/" });
    return { thread, userSettings };
  },
  component: ThreadPage,
});

function ThreadPage() {
  const { threadId } = Route.useParams();
  const { thread, userSettings } = Route.useLoaderData();
  return <ChatView threadId={threadId} initialMessages={thread.messages.map(storedToUi)} userSettings={userSettings} />;
}
