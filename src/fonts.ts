import { setTheme, token } from "nsh";
import theme from "../theme.json";
import Inter from "./assets/fonts/Inter.ttf";
import JetBrainsMono from "./assets/fonts/JetBrainsMono.ttf";

export const fonts = { ui: Inter, mono: JetBrainsMono };
export const defaultEditorFontSize = theme.cssVars.theme["editor-text-size"];

export function applyTypography(percent: number, editorSize: number) {
  if (percent === 100 && editorSize === defaultEditorFontSize) {
    setTheme(null);
    return;
  }
  const scale = percent / 100;
  const typography = Object.fromEntries(
    Object.entries(theme.cssVars.theme).map(([name, value]) => [
      name,
      typeof value === "number" &&
      (name.startsWith("text-size-") || name.startsWith("line-height-"))
        ? value * scale
        : value,
    ]),
  );
  setTheme({
    cssVars: {
      ...theme.cssVars,
      theme: { ...typography, "editor-text-size": editorSize * scale },
    },
  });
}

// Editor props take point sizes directly instead of resolving text utilities.
export function scaledFontSize(points: number) {
  return (points * token("text-size-12")) / 12;
}

export function editorLineHeight(size = token("editor-text-size")) {
  return size * 1.5;
}
