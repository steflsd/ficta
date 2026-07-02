import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CreateWorkspaceForm } from "./CreateWorkspaceForm";

export function CreateWorkspaceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create workspace</DialogTitle>
          <DialogDescription>Create a new WorkOS organization and switch into it.</DialogDescription>
        </DialogHeader>
        <CreateWorkspaceForm onCancel={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
