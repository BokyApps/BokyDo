# Accessibility

BokyDo aims to meet **WCAG 2.2 level AA** on the web app. This page says what that means in
practice, how it is checked, what has _not_ been checked, and how to repeat the check after UI
changes (the plan says to repeat it after every big one).

## How it is checked

`docker/a11y-audit.mjs` drives headless Chrome through a running instance and fails on any finding:

- **axe-core** (WCAG 2.0, 2.1 and 2.2 A and AA, plus best practices) on every main screen, menu and
  dialog, in light and dark, at desktop and phone width, and on the admin pages. It seeds its own
  project, tasks and filter, so a fresh instance and one user are enough.
- **Keyboard**: every tab stop has a visible, unobscured focus indicator and an accessible name;
  no keyboard traps; dialogs take and give back focus; the page title and focus follow
  navigation; single-key shortcuts can be turned off; dragging has alternatives and spoken
  announcements.
- **Reflow** at 320 CSS px (400% zoom) and the WCAG text-spacing overrides.
- The theme contrast tests (`packages/themes`) check every one of the 28 theme variants.

Run it against a throwaway stack (see the header of the script for the exact command). It is not
part of CI because it needs a running instance.

**What this cannot show.** Automated checks find roughly a third to a half of accessibility
problems. The audit was **not** done with a real screen reader (NVDA, JAWS, VoiceOver, Orca), with
speech-input or switch software, or by people who rely on them; the semantics were verified through
axe, the accessibility tree and keyboard automation. Before v1.0 (W13) have that testing done and
treat what it finds as defects.

## What was found and fixed (W12b, 2026-10-07)

The first run found 42 violations of 7 rules; widening its coverage (board and calendar layouts,
menus, dialogs, admin pages, phone width) found more. All were fixed, and the audit now passes.

| Area                 | Problem                                                                                                                                                | Fix                                                                                                                                                                                                              | WCAG                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Lists                | `ul > div > li` around drag wrappers; Upcoming's day strip used `role=listitem` on buttons                                                             | The drag library's ref goes on the `li` itself; day strip is a real list                                                                                                                                         | 1.3.1               |
| Task rows            | `aria-selected` on a generic div (not allowed); no name for a focusable row                                                                            | A labelled group (title, details), with "Selected." spoken in the details                                                                                                                                        | 1.3.1, 4.1.2        |
| Names                | Visible text missing from accessible names ("Home" vs the logo, "Priority 1" vs "P1", template buttons, account menu)                                  | Names now contain the visible text                                                                                                                                                                               | 2.5.3               |
| Colour               | Semantic colours (due labels, errors) derived to 3:1 but used as small text; danger/success badges on their own tints; accent used as link text at 3:1 | Derived at 4.5:1 (22 of 28 variants were affected); tint-aware for danger/success; accent at 4.5:1                                                                                                               | 1.4.3               |
| Links                | Underline only on hover, colour contrast with surrounding text under 3:1                                                                               | Always underlined                                                                                                                                                                                                | 1.4.1               |
| Quick-add highlights | A coloured wash behind typed text lowered its contrast in some themes                                                                                  | A coloured underline instead; text sits on the plain background                                                                                                                                                  | 1.4.3               |
| Board                | Cards were a `role=button` list item containing other buttons                                                                                          | Plain list item plus a real "Move" handle button, announced                                                                                                                                                      | 4.1.2               |
| Calendar             | `grid` without rows                                                                                                                                    | Header and each week are `row`s                                                                                                                                                                                  | 1.3.1               |
| Pop-ups              | Dialog panels had no name; focus was lost when one closed                                                                                              | Named by their button; focus returns to it                                                                                                                                                                       | 4.1.2, 2.4.3        |
| Unnamed control      | Icon-only reschedule button in task rows                                                                                                               | Named "Schedule"                                                                                                                                                                                                 | 4.1.2               |
| Nested controls      | Description button wrapped its own links                                                                                                               | Content and a separate "Edit description" button                                                                                                                                                                 | 4.1.2               |
| Landmarks            | Account and admin pages nested a second `main`                                                                                                         | One `main` per page                                                                                                                                                                                              | 1.3.1               |
| Targets              | Checkboxes, drag handle and card title under 24 px                                                                                                     | 24 px hit areas                                                                                                                                                                                                  | 2.5.8               |
| Page titles          | Every screen was titled just "BokyDo"; no cue on navigation                                                                                            | Title from the page heading; focus moves to the main region; the new page is announced                                                                                                                           | 2.4.2, 2.4.3, 4.1.3 |
| Shortcuts            | Single-letter shortcuts could not be turned off                                                                                                        | Settings → General → "Single-key keyboard shortcuts"; arrows, Enter and Delete keep working                                                                                                                      | 2.1.4               |
| Dragging             | Reordering and nesting were drag-only                                                                                                                  | Task menu: Move up, Move down, Make sub-task, Move out (the same placements a drag makes); moving between sections is in the task panel's project picker; Upcoming's drag has the date picker as its alternative | 2.5.7               |
| Drag announcements   | dnd-kit read out ids ("Draggable item 2f04… was moved over…")                                                                                          | Spoken in terms of task, section, column and day names                                                                                                                                                           | 4.1.3               |
| Toasts               | Undo toasts vanished after 6 s                                                                                                                         | Pause while hovered or focused, last 10 s, dismiss button                                                                                                                                                        | 2.2.1               |
| Focus                | Task rows showed focus only by a faint background                                                                                                      | A visible ring; a global ring for anything unstyled                                                                                                                                                              | 2.4.7, 1.4.11       |

## Decisions

- **Shortcuts stay on by default**, as in Todoist, with the switch in Settings. Row shortcuts (j,
  k, e, x, c, 1–4) only act while a row has focus, and are also off when the switch is off.
- **Accent colour is nudged, not replaced.** 16 of 28 published accents already pass 4.5:1 on
  every surface; the rest move the least distance that does. Text on an accent wash (active
  sidebar item, selected layout, avatar) uses the normal text colour.
- **Pop-ups are `dialog`-role panels named by their button**, not full ARIA menus. They are
  ordinary buttons in tab order after the trigger; Escape closes and returns focus.

## Known gaps

- No testing with real assistive technology (above).
- The Upcoming drag-to-reschedule has no keyboard drag, only the date picker (an equivalent
  function, so 2.1.1 and 2.5.7 are met, but it is a different route).
- Strings are English-only (W12c).
- The PWA/offline work (W12a) and Android (A2, A4) need their own pass.
