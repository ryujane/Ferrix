import { token } from "nsh";
import type { TagColor } from "../../data/connections/connection-model";

export const colors: Record<TagColor, string> = {
  get blue() {
    return token("steel");
  },
  get coral() {
    return token("primary");
  },
  get violet() {
    return token("chart-4");
  },
  get green() {
    return token("success");
  },
  get amber() {
    return token("chart-3");
  },
  get slate() {
    return token("faint");
  },
};
