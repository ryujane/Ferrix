import { t } from "../../i18n";

export const workspaceT = (key: string, values?: Record<string, unknown>) =>
  t(`workspace.${key}`, values);
