import { isAvailable, titleBar } from "nsh/desktop";

export function titleBarArea(): {
  left: number;
  right: number;
  height: number;
} {
  if (!isAvailable) {
    return { left: 0, right: 0, height: 0 };
  }
  return titleBar();
}
