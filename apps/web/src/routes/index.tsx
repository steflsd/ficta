import { createFileRoute } from "@tanstack/react-router";
import { ChatView } from "@/components/chat/ChatView";
import { fetchUserSettings } from "@/lib/storage/settings";

/** The chat page. Loads the viewer's settings so the composer opens on their preferred default model. */
export const Route = createFileRoute("/")({
  loader: () => fetchUserSettings(),
  component: IndexPage,
});

function IndexPage() {
  const settings = Route.useLoaderData();
  return <ChatView userSettings={settings} />;
}
