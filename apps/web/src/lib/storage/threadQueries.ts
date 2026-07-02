import type { QueryClient } from "@tanstack/react-query";
import { fetchThreads } from "./threads";

export const threadKeys = {
  all: ["threads"] as const,
};

export const threadsQueryOptions = {
  queryKey: threadKeys.all,
  queryFn: () => fetchThreads(),
};

export function invalidateThreads(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: threadKeys.all });
}
