# Maestri Design Deconstruction

A reverse-engineering of the design language, visual system, and interaction patterns behind [Maestri](https://www.themaestri.app/en) — a native macOS infinite canvas for orchestrating AI coding agents.

---

## 1. Design Philosophy

Maestri follows three core principles that drive every design decision:

**Spatial over hierarchical.** Work lives on an infinite 2D canvas, not in tabs or sidebars. This mirrors how people think — spreading things out on a desk rather than stacking them in folders.

**Native over emulated.** Everything is SwiftUI + AppKit + Metal. No Electron, no web views. The app inherits macOS system conventions (dark mode, accessibility, Liquid Glass) for free and feels like it belongs on the platform.

**Invisible chrome.** The UI gets out of the way. The canvas IS the app. Toolbars, panels, and controls exist to serve the spatial metaphor, not to impose structure.

---

## 2. Color System

### Light Mode (Website / Marketing)

| Role | Value | Usage |
|------|-------|-------|
| Primary text | `#1d1d1f` | Headings, body copy |
| Secondary text | `neutral-500` | Descriptions, metadata |
| Tertiary text | `neutral-400` | Hints, disabled states |
| Muted text | `black/50`, `black/35` | De-emphasized labels |
| Background | `#ffffff` | Page, cards |
| Surface | `neutral-100` | Badges, pills, subtle fills |
| Border | `neutral-200` | Card edges, dividers |

### Dark Mode (App / Canvas)

| Role | Value | Usage |
|------|-------|-------|
| Primary text | `#ffffff` | Headings, labels |
| Secondary text | `white/70` | Body text |
| Tertiary text | `white/60`, `white/40` | Muted content |
| Background | `#000000` | Canvas, main surface |
| Surface | `neutral-900` | Cards, panels, terminal nodes |
| Border | `white/20`, `white/10` | Node edges, subtle separators |

### Accent Palette

| Name | Value | Usage |
|------|-------|-------|
| Primary gradient | `#1633F9` -> `#9653F4` -> `#1633F9` | CTA buttons, brand moments |
| Purple accent | `#8B5CF6` -> `#A855F7` -> `#C084FC` | Gradient text, highlights |
| Badge purple | `#9653F4` | "New" indicators |
| Success green | `emerald-400` / `emerald-500` | Check icons, positive states |
| Indigo tint | `indigo-50/80` -> `purple-50/80` | Subtle feature backgrounds |

### Design Insight

The accent system is restrained — blue-to-purple gradients appear only on primary CTAs and brand moments. Everything else is monochrome. This makes the gradient pops feel intentional and premium rather than decorative.

---

## 3. Typography

### Font Stack

```
system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif
```

No custom web font. This is deliberate — it matches the native macOS system font (SF Pro) on Apple devices, reinforcing the "this is a native app" identity even on the marketing site.

### Scale

| Level | Size | Weight | Leading | Usage |
|-------|------|--------|---------|-------|
| Display | `clamp(2rem, 5vw, 4rem)` | Bold | `1.1` (tight) | Hero headline |
| H1 | `text-5xl` | Bold | Tight | Section titles |
| H2 | `text-3xl` | Bold | Tight | Feature headers |
| H3 | `text-2xl` | Semibold | Tight | Card titles |
| Body | `clamp(0.95rem, 2vw, 1.35rem)` | Regular | Relaxed | Descriptions |
| Label | `text-xs` | Medium | Normal | Badges, categories (uppercase, tracked) |

### Typographic Patterns

- **Gradient text** for emphasis: purple gradient applied via `background-clip: text` on key phrases
- **`text-balance`** used on headings for optimal line breaks
- **Uppercase + letter-spacing** (`tracking-wide`) exclusively on small labels/badges — never on headings
- Tight leading on headings (`1.1`) creates density; relaxed leading on body creates readability

---

## 4. Spacing & Layout

### Spacing Scale

| Token | Value | Usage |
|-------|-------|-------|
| Section padding | `py-24` to `py-32` | Vertical breathing room between sections |
| Card padding | `p-6` to `p-10` | Internal card spacing |
| Component gap | `gap-4` (16px) | Grid gaps, list spacing |
| Text gap | `mt-4` to `mt-6` | Between heading and body |
| Fine gap | `gap-2` (8px) | Icon + label, tight groupings |

### Container Widths

| Width | Usage |
|-------|-------|
| `max-w-6xl` | Full-width feature sections |
| `max-w-3xl` | Centered text blocks |
| `max-w-2xl` | Narrow prose |
| `max-w-lg` | Single-column focused content |

### Grid System

- Two-column (`md:grid-cols-2`) for feature pairs
- Three-column (`md:grid-cols-3`) for pricing / comparison
- Column spanning (`md:col-span-2`) for hero feature cards
- Mobile-first stack: everything is `flex-col` by default, grid at `md:` breakpoint

### Design Insight

Generous whitespace is the single biggest contributor to the "premium" feel. Section padding of `py-24` (96px) to `py-32` (128px) is unusually large — most apps use half that. It gives every feature room to breathe and avoids the "wall of content" feeling.

---

## 5. Component Library

### Buttons

**Primary CTA:**
```
Outer: bg-gradient-to-r from-[#1633F9] via-[#9653F4] to-[#1633F9] p-[3px] rounded-full
Inner: bg-[#1d1d1f] px-8 py-3.5 rounded-full text-white
Hover: bg-[#2d2d2f]
```
The 3px gradient border trick — a gradient wrapper with padding that reveals the gradient as a border around the dark inner fill. Creates a glowing edge effect without `border-image`.

**Secondary:**
```
border border-neutral-200 rounded-full px-8 py-3.5
Hover: bg-neutral-50
```

**Dark secondary:**
```
border-white/20 rounded-full
Hover: bg-white/10
```

### Cards

**Feature card (light):**
```
rounded-3xl border border-neutral-200 bg-white p-8
min-h-[200px] md:min-h-[240px]
flex flex-col justify-between
```

**Feature card (dark):**
```
rounded-3xl bg-neutral-900 p-8
```

Cards use `justify-between` to push content to top and media to bottom, creating consistent visual rhythm even when text lengths vary.

### Badges & Pills

**Category label:**
```
rounded-full bg-neutral-100 px-4 py-1.5
text-xs font-medium uppercase tracking-wide text-neutral-500
```

**"New" indicator:**
```
inline-flex rounded-full bg-[#9653F4] px-3 py-1
text-xs font-semibold text-white
```

### Media Containers

```
rounded-2xl md:rounded-3xl overflow-hidden w-full
Video: autoPlay muted loop playsInline
```

**Fade mask on media:**
```css
mask-image: linear-gradient(to bottom, transparent, black 25%, black);
```
Images/videos fade in from the top edge, creating a soft bleed into the card. This avoids hard content boundaries.

**Overflow technique:** Some images use `w-[120%] -ml-[10%]` to bleed past card edges, creating depth and breaking the grid rigidity.

### Icons

- Inline SVG, `viewBox="0 0 24 24"`
- Stroke-based: `strokeWidth: 2`, `strokeLinecap: round`, `strokeLinejoin: round`
- Color-coded by meaning: `emerald-500` (success/check), `neutral-300` (negative/x), `white` (on dark)
- Sizes: `h-5 w-5` (standard), `h-4 w-4` (compact)

---

## 6. The Canvas (App UI)

This is the core of Maestri's design identity — the infinite canvas where all work happens.

### Canvas Surface

- **Background:** Deep black (`#000` or near-black) — the canvas is always dark regardless of system appearance
- **GPU-accelerated** via Metal — smooth pan/zoom at any scale with no dropped frames
- **Infinite in all directions** — no edges, no scroll bars, just space

### Terminal Nodes

Each terminal is a discrete visual node placed freely on the canvas:

- Rounded rectangle container (likely `rounded-2xl` or similar)
- Dark surface (`neutral-900` range) with subtle border (`white/10`)
- **Title bar** at top with terminal name / agent label
- **Terminal content** rendered via SwiftTerm with pixel-perfect TUI output at every zoom level
- Nodes are **draggable** — position anywhere on the canvas
- Support for resize (implied by terminal behavior)

### Sticky Notes

- Lighter card surface to contrast with terminal darkness
- Markdown-rendered content
- Connected to terminals — agents write directly to them
- Visual distinction from terminals (different background tint or border treatment)

### Sketching Layer

- **Freehand drawing** — pencil/brush tool for hand-drawn shapes
- **Geometric shapes** — rectangles, circles for diagrams
- **Arrows** — directional connections between components
- Hand-drawn aesthetic ("shapes that feel natural and fast") suggests a slightly rough/organic stroke rendering, not rigidly geometric
- Layered beneath or above nodes depending on context

### Connection Lines

The signature interaction — drag a line between two terminals to enable agent-to-agent communication:

- Visual line/arrow connecting two terminal nodes
- Likely rendered as a bezier curve or straight line with directional indicator
- Represents PTY orchestration — the line IS the communication channel
- No middleware visualization — the connection is direct and clean

### Toolbar

- Minimal — follows macOS conventions
- **Liquid Glass** material on macOS 26+ (translucent, refractive glass effect)
- Likely contains: pan/select tool, sketch tools, add terminal, add note, zoom controls
- Positioned to not obstruct canvas (probably top bar or floating)

### Zoom Behavior

- Semantic zoom — TUI content remains pixel-perfect at every level
- Zoom out: see the full workspace topology (agent graph overview)
- Zoom in: focus on a single terminal's output in full detail
- Smooth interpolation (Metal rendering ensures no stuttering)

### Design Insight

The canvas-as-workspace metaphor works because of the contrast between the dark infinite void and the bright, self-contained nodes. Each terminal/note is a "island of activity" floating in space. The darkness creates natural visual separation without needing explicit layout rules.

---

## 7. Interaction Patterns

### Spatial Navigation

| Action | Behavior |
|--------|----------|
| Pan | Click + drag on canvas background |
| Zoom | Pinch / scroll wheel / trackpad gesture |
| Select node | Click on terminal / note |
| Move node | Drag selected node |
| Connect | Drag line from one terminal to another |

### Keyboard-Driven Workflow

- **tmux-style shortcuts** for workspace switching — power users never need the mouse for navigation
- Single-key launcher for adding terminals, notes
- Editor launching (VS Code, Zed, Xcode) via shortcut or context action

### Agent Lifecycle

1. Terminal node appears on canvas
2. Agent starts working (visible output in TUI)
3. Ombro (on-device AI) monitors progress silently
4. On completion: Ombro summarizes what happened + suggests next step
5. User can connect terminal to another for handoff

### Floors (Workspace Cloning)

- **Instant copy** of entire workspace via APFS copy-on-write
- Zero-cost branching of your canvas state
- Visual metaphor: "floors" in a building — same layout, different state

---

## 8. Visual Effects & Polish

### Liquid Glass (macOS 26+)

Maestri adopts Apple's Liquid Glass design language:
- Translucent toolbar with refractive glass material
- System-consistent appearance that adapts to wallpaper and content beneath
- Built-in via SwiftUI/AppKit on macOS Tahoe — not a custom implementation

### Transparency & Depth

| Effect | Implementation |
|--------|----------------|
| Glass surfaces | `bg-white/10`, system vibrancy materials |
| Layered depth | Nodes cast subtle shadows on canvas |
| Fade masks | `linear-gradient` masks on media for soft edges |
| Gradient borders | 3px gradient wrapper technique on CTAs |

### Motion

- Canvas pan/zoom: 60fps via Metal, no dropped frames
- Terminal animations: every frame renders without stutter (SwiftTerm GPU backend)
- Node dragging: direct manipulation with no lag
- Workspace switching: tmux-speed transitions

### Dark Mode

- The canvas is inherently dark (always dark)
- The app shell respects system dark/light mode for chrome elements
- Dark mode isn't an afterthought — it's the primary design context

---

## 9. Design Principles (Extracted)

These aren't stated by the developer but are clearly evident in every decision:

1. **Density without clutter.** Multiple terminals, notes, and sketches coexist because the infinite canvas provides unlimited space. You control density by zooming.

2. **Direct manipulation over menus.** Connect agents by dragging a line. Move things by dragging them. Sketch by drawing. The interface is the interaction.

3. **Platform fidelity.** No cross-platform compromise. SwiftUI for UI, Metal for rendering, APFS for cloning, Apple Intelligence for AI. Every macOS capability is leveraged.

4. **Progressive disclosure.** Free tier gives you one workspace with everything. Complexity (multiple workspaces, multi-Mac) unlocks with Pro. The learning curve is the canvas itself.

5. **Privacy as design.** Zero telemetry isn't just a feature — it shapes the architecture. Local JSON + Markdown storage means your workspace is inspectable, portable, and yours.

---

## 10. What Makes It Feel Premium

A checklist of the subtle details that elevate Maestri above typical developer tools:

- [ ] System font (SF Pro) instead of a custom font — feels native, not branded
- [ ] `rounded-3xl` (24px radius) on cards — softer than the typical `rounded-lg`
- [ ] 96-128px section padding — extreme breathing room
- [ ] Gradient used sparingly (only primary CTA + select text highlights)
- [ ] Monochrome palette with a single accent hue family (blue-purple)
- [ ] Media bleeds past container edges (`w-[120%]`) — breaks grid monotony
- [ ] Fade masks on images — no hard content cutoffs
- [ ] Stroke-based icons (not filled) — lighter visual weight
- [ ] Uppercase labels with tracking — clear hierarchy without size changes
- [ ] Zero decorative elements — no illustrations, no mascots, no gradients-for-the-sake-of-gradients

---

## 11. Technology Enabling Design

| Design Goal | Technology |
|-------------|-----------|
| Smooth infinite canvas | Metal GPU rendering |
| Pixel-perfect terminals at any zoom | SwiftTerm GPU-accelerated backend |
| Native look & feel | SwiftUI + AppKit |
| Liquid Glass chrome | macOS 26 system materials |
| Instant workspace cloning | APFS copy-on-write |
| On-device AI companion | Apple Foundation Models |
| Zero-latency interactions | Native Swift (no JS bridge overhead) |

---

*Deconstructed from [themaestri.app](https://www.themaestri.app/en), Product Hunt, changelog, and public materials. App is closed-source; some details are inferred from observable behavior and stated technical choices.*
