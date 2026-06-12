import { SettingsForm } from "@/components/SettingsForm";
import { TemplateEditor } from "@/components/TemplateEditor";

export default function SettingsPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-5 animate-fade-up">
      <SettingsForm />
      <TemplateEditor />
    </div>
  );
}
