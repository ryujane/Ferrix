import { Clipboard } from "nsh";
import { useToast } from "../components/toast";
import { t } from "../i18n";

export function useClipboardCopy() {
  const toast = useToast();
  return async (text: string): Promise<boolean> => {
    const result = await Clipboard.writeText(text).catch(() => "failed");
    if (result === "failed") {
      toast.error(t("toast.copyFailed"), { id: "clipboard" });
      return false;
    }
    toast.success(t("toast.copied"), { id: "clipboard" });
    return true;
  };
}
