import { createFileRoute } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { CreateWorkspaceForm } from "@/components/onboarding/CreateWorkspaceForm";
import { Button } from "@/components/ui/button";
import { fetchOrganizations, switchOrganization } from "@/lib/auth/auth";
import type { OrgSummary } from "@/lib/auth/types";

export const Route = createFileRoute("/onboarding")({
  loader: () => fetchOrganizations(),
  component: OnboardingPage,
});

function OnboardingPage() {
  const orgs = Route.useLoaderData();
  const [showCreate, setShowCreate] = useState(orgs.length === 0);
  const [switchingOrgId, setSwitchingOrgId] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const hasOrgs = orgs.length > 0;

  const continueToOrg = async (org: OrgSummary) => {
    if (switchingOrgId) return;
    setSwitchingOrgId(org.id);
    setError(undefined);
    try {
      await switchOrganization({ data: { organizationId: org.id } });
      window.location.assign("/");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not switch workspace");
      setSwitchingOrgId(null);
    }
  };

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10 text-foreground">
      <section className="w-full max-w-md rounded-2xl border border-border bg-card p-6 text-card-foreground shadow-sm">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl border border-border bg-secondary">
          <ShieldCheck className="size-6 text-emerald-600 dark:text-emerald-400" aria-hidden />
        </div>
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Create your workspace</h1>
          <p className="mt-2 text-muted-foreground text-sm">
            Workspaces keep chats and settings scoped to the organization you are working in.
          </p>
        </div>

        {hasOrgs ? (
          <div className="space-y-3">
            <div className="space-y-2">
              <p className="text-muted-foreground text-sm">Continue with an existing workspace:</p>
              {orgs.map((org) => (
                <Button
                  key={org.id}
                  type="button"
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => continueToOrg(org)}
                  disabled={switchingOrgId !== null}
                >
                  {switchingOrgId === org.id ? "Switching…" : `Continue to ${org.name}`}
                </Button>
              ))}
            </div>

            {error ? (
              <p
                className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-sm"
                role="alert"
              >
                {error}
              </p>
            ) : null}

            {showCreate ? (
              <div className="border-border border-t pt-4">
                <CreateWorkspaceForm onCancel={() => setShowCreate(false)} />
              </div>
            ) : (
              <Button type="button" variant="ghost" className="w-full" onClick={() => setShowCreate(true)}>
                Create a new workspace
              </Button>
            )}
          </div>
        ) : (
          <CreateWorkspaceForm />
        )}
      </section>
    </main>
  );
}
