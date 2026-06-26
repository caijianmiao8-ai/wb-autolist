import { SettingsForm } from "@/components/SettingsForm";

export default function SettingsPage() {
  // SettingsForm is the full-height settings frame (header + scrollable body with
  // the folded 高级设置 incl. the image-prompt template editor + sticky save).
  return <SettingsForm />;
}
