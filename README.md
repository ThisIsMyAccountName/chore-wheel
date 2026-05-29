# 🎡 Chore Wheel Card

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-41BDF5.svg)](https://github.com/hacs/integration)

A carnival-style **spinning wheel** for Home Assistant that turns your chore
list into a game. The wheel is built from a Home Assistant **`todo` list**:
hit **Spin**, watch the wheel land on a chore, then tap **Mark done** to strike
it off the list.

![chore wheel](https://raw.githubusercontent.com/ThisIsMyAccountName/chore-wheel/main/.github/preview.png)

---

## Features

- 🎯 Reads chores live from any `todo.*` entity (Local To-do, Shopping List, etc.)
- 🎡 Smooth, weighted-fair carnival wheel with a real spin animation
- ✅ "Mark done" button completes (or removes) the chosen item from the list
- ➕ One-tap **quick-add chips** to drop common chores onto the wheel
- 🔄 Auto-updates when the todo list changes
- 🎨 Colour families (or a custom palette), customisable title and spin duration
- 🖱️ Visual config editor — no YAML required
- 📦 Zero dependencies, no build step

---

## Prerequisites: a todo list

The card needs a `todo` entity to read chores from. The easiest is the built-in
**Local To-do** integration:

1. **Settings → Devices & Services → Add Integration → Local To-do**
2. Give it a name, e.g. `Chores`. This creates `todo.chores`.
3. Add chores to it from any Todo-list card, the To-do panel, or via the
   `todo.add_item` service.

Any integration that provides a `todo` entity works.

---

## Installation

### HACS (recommended)

This is a **custom repository** until it is added to the default HACS store.

1. In Home Assistant go to **HACS → ⋮ (top right) → Custom repositories**.
2. Add `https://github.com/ThisIsMyAccountName/chore-wheel` with category **Dashboard**.
3. Search for **Chore Wheel Card**, install it.
4. HACS adds the Lovelace resource automatically. (If not, add the resource
   below.)

### Manual

1. Copy `dist/chore-wheel-card.js` into `<config>/www/chore-wheel-card.js`.
2. **Settings → Dashboards → ⋮ → Resources → Add resource**
   - URL: `/local/chore-wheel-card.js`
   - Type: **JavaScript Module**
3. Refresh your browser (hard reload).

---

## Usage

Add the card to a dashboard. Use the visual editor, or YAML:

```yaml
type: custom:chore-wheel-card
entity: todo.chores
```

### Full configuration

```yaml
type: custom:chore-wheel-card
entity: todo.chores          # required — a todo.* entity
title: Chore Wheel           # heading shown above the wheel
spin_duration: 5             # seconds the spin animation runs (1–20)
strike_action: complete      # "complete" (mark done) or "remove" (delete item)
show_completed: false        # also include already-completed items on the wheel
color_family: rainbow        # rainbow | warm | cool | pastel | earth
quick_chores:                # one-tap chips that add a chore to the list
  - Dishes
  - Vacuum
  - Take out trash
colors:                      # optional custom palette — overrides color_family
  - "#e6194b"
  - "#3cb44b"
  - "#4363d8"
```

### Options

| Option           | Type     | Default        | Description                                                        |
| ---------------- | -------- | -------------- | ------------------------------------------------------------------ |
| `entity`         | string   | **required**   | A `todo.*` list entity. Its incomplete items become wheel slices.  |
| `title`          | string   | `Chore Wheel`  | Heading shown above the wheel.                                     |
| `spin_duration`  | number   | `5`            | Length of the spin animation in seconds.                          |
| `strike_action`  | string   | `complete`     | What "Mark done" does: `complete` (mark item done) or `remove`.   |
| `show_completed` | boolean  | `false`        | Include completed items on the wheel as well.                     |
| `color_family`   | string   | `rainbow`      | Built-in palette: `rainbow`, `warm`, `cool`, `pastel` or `earth`. |
| `quick_chores`   | list     | `[]`           | Chore labels shown as one-tap chips that add the chore to the list.|
| `colors`         | list     | built-in       | Custom hex palette, cycled in order. Overrides `color_family`.    |

---

## How it works

- On load (and whenever the todo entity changes) the card calls the
  `todo/item/list` websocket command and builds one wheel slice per
  not-completed item.
- **Spin** picks a slice uniformly at random and animates the wheel to land on
  it with an ease-out, plus a small in-slice jitter so it never looks rigged.
- **Mark done** calls `todo.update_item` (status `completed`) or
  `todo.remove_item`, then re-reads the list — so the finished chore drops off
  the wheel.
- **Quick-add chips** call `todo.add_item` with the chip's label, then re-read
  the list — so the new chore appears on the wheel immediately.

---

## License

[MIT](LICENSE)
# chore-wheel
