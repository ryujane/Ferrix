---
name: Obsidian Crimson Engine
colors:
  surface: '#0b1326'
  surface-dim: '#0b1326'
  surface-bright: '#31394d'
  surface-container-lowest: '#060e20'
  surface-container-low: '#131b2e'
  surface-container: '#171f33'
  surface-container-high: '#222a3d'
  surface-container-highest: '#2d3449'
  on-surface: '#dae2fd'
  on-surface-variant: '#e4beba'
  inverse-surface: '#dae2fd'
  inverse-on-surface: '#283044'
  outline: '#ab8986'
  outline-variant: '#5b403e'
  surface-tint: '#ffb3ad'
  primary: '#ffb3ad'
  on-primary: '#68000a'
  primary-container: '#ff5451'
  on-primary-container: '#5c0008'
  inverse-primary: '#b91a24'
  secondary: '#7bd0ff'
  on-secondary: '#00354a'
  secondary-container: '#00a6e0'
  on-secondary-container: '#00374d'
  tertiary: '#4edea3'
  on-tertiary: '#003824'
  tertiary-container: '#00a572'
  on-tertiary-container: '#00311f'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#ffdad7'
  primary-fixed-dim: '#ffb3ad'
  on-primary-fixed: '#410004'
  on-primary-fixed-variant: '#930013'
  secondary-fixed: '#c4e7ff'
  secondary-fixed-dim: '#7bd0ff'
  on-secondary-fixed: '#001e2c'
  on-secondary-fixed-variant: '#004c69'
  tertiary-fixed: '#6ffbbe'
  tertiary-fixed-dim: '#4edea3'
  on-tertiary-fixed: '#002113'
  on-tertiary-fixed-variant: '#005236'
  background: '#0b1326'
  on-background: '#dae2fd'
  surface-variant: '#2d3449'
typography:
  headline-lg:
    fontFamily: Inter
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
    letterSpacing: -0.015em
  headline-md:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '600'
    lineHeight: 22px
    letterSpacing: -0.01em
  headline-sm:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '600'
    lineHeight: 20px
    letterSpacing: -0.005em
  body-md:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 18px
    letterSpacing: 0em
  body-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
    letterSpacing: 0em
  code-lg:
    fontFamily: JetBrains Mono
    fontSize: 13px
    fontWeight: '500'
    lineHeight: 20px
    letterSpacing: -0.005em
  code-md:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 18px
    letterSpacing: 0em
  code-sm:
    fontFamily: JetBrains Mono
    fontSize: 11px
    fontWeight: '400'
    lineHeight: 14px
    letterSpacing: 0.02em
  badge-label:
    fontFamily: JetBrains Mono
    fontSize: 10px
    fontWeight: '700'
    lineHeight: 12px
    letterSpacing: 0.05em
  shortcut-key:
    fontFamily: Inter
    fontSize: 10px
    fontWeight: '600'
    lineHeight: 12px
    letterSpacing: 0.04em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  gutter: 0.5rem
  gutter-compact: 0.25rem
  margin: 0.75rem
  margin-mobile: 0.5rem
  space-xs: 0.25rem
  space-sm: 0.375rem
  space-md: 0.5rem
  space-lg: 0.75rem
  space-xl: 1rem
themes:
  light:
    name: Precision Data Studio
    colors:
      surface: '#f8f9ff'
      surface-dim: '#cbdbf5'
      surface-bright: '#f8f9ff'
      surface-container-lowest: '#ffffff'
      surface-container-low: '#eff4ff'
      surface-container: '#e5eeff'
      surface-container-high: '#dce9ff'
      surface-container-highest: '#d3e4fe'
      on-surface: '#0b1c30'
      on-surface-variant: '#5c3f40'
      inverse-surface: '#213145'
      inverse-on-surface: '#eaf1ff'
      outline: '#906f70'
      outline-variant: '#e5bdbe'
      surface-tint: '#be0037'
      primary: '#b80035'
      on-primary: '#ffffff'
      primary-container: '#e11d48'
      on-primary-container: '#fffaf9'
      inverse-primary: '#ffb3b6'
      secondary: '#006398'
      on-secondary: '#ffffff'
      secondary-container: '#5bb8fe'
      on-secondary-container: '#00476e'
      tertiary: '#006848'
      on-tertiary: '#ffffff'
      tertiary-container: '#00845c'
      on-tertiary-container: '#eefff3'
      error: '#ba1a1a'
      on-error: '#ffffff'
      error-container: '#ffdad6'
      on-error-container: '#93000a'
      primary-fixed: '#ffdada'
      primary-fixed-dim: '#ffb3b6'
      on-primary-fixed: '#40000c'
      on-primary-fixed-variant: '#920028'
      secondary-fixed: '#cce5ff'
      secondary-fixed-dim: '#93ccff'
      on-secondary-fixed: '#001d31'
      on-secondary-fixed-variant: '#004b73'
      tertiary-fixed: '#85f8c4'
      tertiary-fixed-dim: '#68dba9'
      on-tertiary-fixed: '#002114'
      on-tertiary-fixed-variant: '#005137'
      background: '#f8f9ff'
      on-background: '#0b1c30'
      surface-variant: '#d3e4fe'
---

Ferrix ships as a **dark-first, dual-theme** design system. **Obsidian Crimson Engine** (dark) is the default and the structural baseline — layout, typography, spacing, radii, and component geometry all come from it. **Precision Data Studio** (light) overrides the color layer only; typography, spacing, and shape tokens are shared. In the frontmatter, root tokens are the dark defaults and `themes.light.colors` holds the light overrides; in the sections below, per-theme values appear side by side wherever they differ. Where the light theme did not specify a component, its values are derived from its own declared palette to mirror the dark structure.

## Brand & Style

This design system delivers a high-performance, developer-first environment tailored for database administrators, backend architects, and software engineers managing Redis instances at scale. Inspired by refined desktop utilities — TablePlus, Medis, DataGrip, GitHub Light, Tiny RDM, and modern IDEs — the interface merges high-density utility with clean aesthetics.

### Personality & Tone
- **Atmosphere**: Deep, cool slate and charcoal surfaces that eliminate eye fatigue during intensive diagnostic and monitoring sessions; in light, unobtrusive instrument-grade neutrals inspired by classic desktop development environments.
- **Accents**: Razor-sharp structural definition with a vibrant signature crimson spark, signaling runtime status, operations, and execution commands.
- **Instrument-grade Precision**: Every element exists to present data without visual distraction or ornamentation.
- **Clarity under Load**: High visual contrast and unambiguous structural boundaries ensure rapid parsing of keys, schemas, and live streams under intense operational pressure.
- **Tone**: Purposeful, low-latency, and disciplined. Interfaces prioritize immediate data legibility, low visual noise, and explicit feedback over ornamental flair.

### Design Style
**Technical Minimalist / Tooling-First** — pure, flat, crisp surfaces separated by structural 1px low-contrast dividers. Depth is established through tonal background variation rather than heavy drop shadows. High-density data tables, monospaced code blocks, and structured multi-pane split views form the core structural identity.

## Colors

Both themes are built on an architectural scale of neutral surfaces punctuated by a focused crimson signature accent, plus semantic tokens for Redis data types and state indicators. Dark leads with deep cool slate (`#0F172A` → `#475569`); light answers with instrument neutrals (`#f8fafc` → `#cbd5e1`).

### Key Roles
| Role | Dark | Light | Usage |
|---|---|---|---|
| **Primary** — Redis Crimson | `#EF4444` (hover `#DC2626`) | `#e11d48` (hover `#be123c`) | Primary actions, execution commands, runtime status, focal points; in dark also the active-tab and selection accent |
| **Secondary** — Steel Blue | `#7bd0ff` | `#0284c7` | `string` data type; in light also navigation selections, active tabs, secondary links |
| **Tertiary** — Emerald | `#4edea3` | `#059669` | Successful execution, connected state, TTL persistence, `hash` data type |
| **Neutral** | `#94A3B8` | `#64748b` | Secondary copy, muted icons, inactive tabs |

Focus ring: dark `rgba(239, 68, 68, 0.45)`; light `rgba(225, 29, 72, 0.15)` at 2px spread.

### Workspace Surfaces & Borders
| Role | Dark | Light |
|---|---|---|
| Canvas base — app shell, toolbars, tree background | `#0F172A` | `#f8fafc` (Slate 50) |
| Panel surface — sidebars, data tables, inspectors | `#1E293B` | `#ffffff` |
| Inset surface — breadcrumbs, table headers, sub-panels | `#0F172A` | `#f1f5f9` (Slate 100) |
| Elevated surface — dialogs, context menus, tooltips, popovers | `#334155` | `#ffffff` |
| Border subtle | `#334155` | `#e2e8f0` (Slate 200) |
| Border strong | `#475569` | `#cbd5e1` (Slate 300) |

### Text & Icon Colors
| Role | Dark | Light |
|---|---|---|
| Text primary | `#F8FAFC` | `#0f172a` |
| Text secondary | `#94A3B8` | `#334155` |
| Text muted (placeholders) | `#64748B` | `#64748b` |

### Redis Data-Type Semantic Tokens
| Type | Badge | Dark accent | Light text | Light fill |
|---|---|---|---|---|
| `type-string` | `STR` | `#3B82F6` Electric Blue | `#0284c7` | `#e0f2fe` |
| `type-hash` | `HASH` | `#10B981` Emerald Green | `#059669` | `#d1fae5` |
| `type-list` | `LIST` | `#F59E0B` Vibrant Amber | `#d97706` | `#fef3c7` |
| `type-set` | `SET` | `#8B5CF6` Bright Violet | `#7c3aed` | `#ede9fe` |
| `type-zset` | `ZSET` | `#EC4899` Magenta Rose | `#db2777` | `#fce7f3` |
| `type-stream` | `STRM` | `#06B6D4` Cyan | `#4f46e5` | `#e0e7ff` |
| `type-json` | `JSON` | `#F97316` Deep Orange | `#0891b2` | `#cffafe` |

Dark badges derive their fill (10% tint) and border (30% opacity) from the type accent; light uses the explicit text/fill pairs above.

## Typography

Typography is shared by both themes; the compact dark scale is canonical.

- **Primary UI (Inter)** handles navigation trees, command palettes, column headers, and control labels. Tighter negative tracking (`-0.01em` to `-0.015em`) is applied to titles to maintain geometric compactness.
- **Code & Keys (JetBrains Mono)** governs all Redis keys, values, raw payloads, TTL values, memory measurements, CLI terminals, and shortcut indicators. Fixed tabular figures eliminate jitter when live metric counters and key indexes refresh; explicit line heights (≈1.5) support dense code inspection without visual collision.
- Text sizes remain intentionally compact (10px to 13px baseline) to maximize structural information density across split panes.
- Font smoothing must be set to subpixel antialiasing on macOS/Windows desktop environments to maintain razor-sharp rendering on dense data grids.

## Layout & Spacing

The layout model is governed by a **multi-pane desktop grid architecture** consisting of collapsible tree-views, resizable vertical splitters, tabular data grids, and inspect-drawer panels.

### Application Frame
- **Leftmost Instance Switcher**: Fixed width (`48px`).
- **Key Browser / Namespace Tree**: Default width (`280px`), min-width (`200px`), resizable via 1px splitter drag targets.
- **Central Workspace**: Flex-fluid with persistent multi-tab header (`32px` height) — tabs, query editor, table / tree / JSON inspector.
- **Right Inspector**: Metadata, memory profiling, TTL details — collapsible split pane (`360px` default).
- **Bottom Dock**: CLI console, query execution log — collapsible.

### Spatial Rhythm
Anchored to a tight 4px baseline sub-grid (`space-xs: 4px`, `space-sm: 6px`, `space-md: 8px`, `space-lg: 12px`, `space-xl: 16px`), with gutters at `0.5rem` (`0.25rem` compact).

### Density & Responsive Behavior
- Toolbars and table row heights stay fixed across all display viewports — compact `28px` standard row, `24px` ultra-dense row — utilizing internal horizontal and vertical canvas scrolling rather than flow wrapping.
- **Desktop (≥ 1280px)**: Three-column layout active, gutter spacing pinned to `0.5rem`, all docks expandable.
- **Tablet / Narrow Screen (768px – 1279px)**: Key Browser collapses to an icon/flyout bar; bottom dock switches to an on-demand modal drawer.
- **Compact (< 768px)**: Strict single-column stack with tabs converting to a dropdown switcher; inspector panes viewable as full-screen sliding sheets.

## Elevation & Depth

Visual separation relies on **low-contrast 1px outlines** and **distinct tonal surface shifts** rather than high-spread blur drop shadows. Dark permits one deep ambient shadow on floating overlays; light keeps shadows faint and diffuse.

| Tier | Dark | Light |
|---|---|---|
| **0 — Base canvas** | `#0F172A` — root app container, tree view backgrounds | `#f8fafc` — outer shell, toolbars, status bars |
| **1 — Panels & tooling** | `#1E293B` bounded by 1px `#334155` — document tables, input bars, inspector panes | `#f1f5f9` bounded by 1px `#e2e8f0` — tree explorer, tab bar wells, panel headers |
| **2 — Focus surface** | Tables ride the panel tier; active tab `#1E293B` | `#ffffff` — active code editor, active grid, active tab; sits optically higher via luminance contrast |
| **3 — Floating overlays** | `#1E293B`, border `#475569`, shadow `0 8px 24px -4px rgba(0, 0, 0, 0.65), 0 2px 6px -1px rgba(0, 0, 0, 0.4)` — command palette (`Cmd+K`), contextual dropdowns, connection modals | `#ffffff`, border `#cbd5e1`, shadow `0 4px 12px -2px rgba(15, 23, 42, 0.08), 0 2px 4px -1px rgba(15, 23, 42, 0.04)` — autocomplete popups, context menus, dialogs |
| **Active selection** | Fill `rgba(51, 65, 85, 0.6)` with 2px left inset `#EF4444` | Tree: `#e0f2fe` + 2px left `#0284c7`; grid: `#eff6ff` (blue-tinted) / `#f0fdf4` (emerald-tinted) + 1px active bounding box |

## Shapes

The interface embraces a calibrated **Soft (Level 1)** geometric form factor, emphasizing utility and technical focus:

- **Global Controls & Inputs**: `4px` (`0.25rem`) radius provides crisp, modern edge control without distracting curves.
- **Type Badges & Micro Chips**: `3px` radius for data-type indicators to keep them compact and legibly bounded within tabular cells.
- **Panels & Dialogs**: `6px` (`0.375rem`) to `8px` (`rounded-lg: 0.5rem`) on parent modals and quick-switcher windows.
- **Splitter Bars & Tabs**: `0px` radius on pane-docked elements to form seamless continuous junctions against adjacent borders. Light may use `rounded-t` 4px top corners where the active tab merges into the white editor surface, with a flat bottom boundary.

## Components

### Buttons
| Variant | Dark | Light |
|---|---|---|
| **Primary** (Run Query / Save Key) | Solid `#EF4444`, text `#FFFFFF`, hover `#DC2626`, transparent border, 4px radius, height `28px` | Solid `#e11d48`, text `#FFFFFF`, hover `#be123c`, transparent border, 4px radius, height `28px` (compact) / `32px` (standard) |
| **Secondary / Ghost** (Refresh / Filter) | Transparent bg, 1px `#334155` border, text `#F8FAFC`, hover bg `#334155` | `#FFFFFF` bg, text `#334155`, 1px `#e2e8f0` border, hover bg `#f8fafc` + border `#cbd5e1` |
| **Icon utility** | `24px × 24px`, center-aligned icon, hover tint `rgba(255, 255, 255, 0.08)` | `24px × 24px`, text `#64748b`, hover bg `#f1f5f9`, hover text `#0f172a` |

### Data-Type Badges
- Compact rectangular tags displaying 3-to-4 character indicators (`STR`, `HASH`, `LIST`, `SET`, `ZSET`, `STRM`, `JSON`), `badge-label` font, `3px` radius, padding `2px 6px`.
- **Dark**: 10% opacity tinted fill of the type accent, 1px border matching the accent at 30% opacity, full foreground saturation for text.
- **Light**: explicit text/fill pairs from the semantic token table (e.g. `STRING` blue `#0284c7` on `#e0f2fe`, `HASH` emerald `#059669` on `#d1fae5`).

### Key-Value Data Tables & Tree Lists
- **Header**: height `26px`, Inter 12px uppercase semi-bold. Dark: `#0F172A` bg, `#94A3B8` text, border-bottom 1px `#334155`. Light: `#f1f5f9` bg, `#64748b` text, border-bottom 1px `#cbd5e1`.
- **Rows**: height `28px` (compact) / `24px` (ultra-dense). Dark: hovered `#1E293B`, selected `#334155` with crimson edge. Light: base `#FFFFFF` with 1px `#f1f5f9` dividers, hovered `#f1f5f9`, selected `#eff6ff` / `#f0fdf4` with a 1px active bounding box.
- **Tree nodes**: `24px` rows, `space-sm` indent per depth level. Dark: selected `rgba(51, 65, 85, 0.6)` + 2px left marker `#EF4444`. Light: selected `#e0f2fe` + 2px left marker `#0284c7`, hovered `#f1f5f9`.
- Mono font (`code-*`) used for key names, TTL countdowns, and size indicators.

### Form Inputs & Query Fields
- Shared: background on the inset surface, 1px subtle border, `4px` radius, monospace mode for CLI input prompts and pattern searches (`KEYS *`).
- **Dark**: bg `#0F172A`, border `#334155`, text `#F8FAFC`, placeholder `#64748B`. Focused: border `#EF4444`, ring `0 0 0 1px #EF4444`.
- **Light**: bg `#FFFFFF`, border `#e2e8f0`, text `#0f172a`, placeholder `#64748b`, mono 13px. Focused: `1px solid #e11d48` + 2px faint spread `rgba(225, 29, 72, 0.15)`, no default browser outline.

### Tabs & Navigation Bars
- Clean tab row docked above views, `32px` header; close icon (`x`) visible on hover or active.
- **Inactive**: transparent bg, border-right 1px — dark text `#94A3B8` on `#334155`; light text `#64748b` on `#e2e8f0`.
- **Active**: dark — bg `#1E293B`, text `#F8FAFC`, top accent 2px `#EF4444`, square-docked. Light — rides the `#FFFFFF` focus surface with a `#0284c7` accent.
- Accent policy: dark steers navigation selections and active tabs to primary crimson; light steers them to secondary steel blue.

### Keyboard Shortcut Chips (`Kbd`)
- Minimal pill element displaying keys (e.g. `⌘K`, `⇧↵`), `shortcut-key` font, padding `1px 4px`, radius `3px`.
- Dark: bg `#0F172A`, border 1px `#475569`, text `#94A3B8`. Light: bg `#f8fafc`, border 1px `#cbd5e1`, text `#64748b`.

### Code Editor Surface
| Token | Dark | Light |
|---|---|---|
| Editor background | `#1E293B` | `#ffffff` |
| Line-number rail | `#0F172A` + 1px `#334155` vertical border | `#f8fafc` + 1px `#e2e8f0` vertical border |
| Keys | `#F8FAFC` | `#0f172a` |
| Strings | `#3B82F6` | `#0284c7` |
| Numbers | `#F59E0B` | `#d97706` |
| Booleans | `#EF4444` | `#e11d48` |
| Punctuation | `#94A3B8` | `#64748b` |

### Status Indicators
- Live ping/connection dot: `6px × 6px` rounded full.
- Connected: dark `#10B981` with pulsing glow `0 0 6px #10B981`; light `#059669`.
- Disconnected / Error: dark `#EF4444` with glow `0 0 6px #EF4444`; light `#e11d48`.
