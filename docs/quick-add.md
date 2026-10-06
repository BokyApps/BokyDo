# Quick add syntax

Type a task the way you'd say it. BokyDo picks out the date, project, labels and the rest,
highlights them as you type, and shows each one as a chip under the name. Remove a chip (×) to
keep those words in the task name instead.

```
Call the plumber tomorrow at 5pm #Home Reno @phone p1 for 30min {fri}
```

| Type           | Means                                         | Examples                                                                                                                                                                                                                                                         |
| -------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a date or time | due date                                      | `today`, `tonight`, `tomorrow 9am`, `5pm`, `fri`, `next fri`, `this weekend`, `next week`, `in 3 days`, `in 2h`, `jan 27`, `27/1`, `2026-10-27`, `on the 20th`, `end of month`, `mid march`                                                                      |
| `every …`      | repeating due date                            | `every day`, `every weekday`, `every mon, wed and fri at 7am`, `every other week`, `every 2nd tue`, `every last fri`, `every 15th`, `every last day`, `every jan 27`, `every 3 months starting aug`, `every mon until dec 1`, `every hour`, `daily` (at the end) |
| `every! …`     | repeat counted from when you complete it      | `every! 3 days`, `every! month`                                                                                                                                                                                                                                  |
| `#Project`     | project (you must be able to add tasks there) | `#Work`, `#Home Reno`, `#Work/Q4 Launch`                                                                                                                                                                                                                         |
| `/Section`     | section of that project                       | `/Next up`                                                                                                                                                                                                                                                       |
| `@label`       | labels (new ones are created)                 | `@phone @errands`                                                                                                                                                                                                                                                |
| `p1`–`p4`      | priority                                      | `p1`                                                                                                                                                                                                                                                             |
| `for …`        | duration                                      | `for 45min`, `for 1h30m`, `for half an hour`                                                                                                                                                                                                                     |
| `{…}`          | deadline                                      | `{next friday}`, `{27/10}`                                                                                                                                                                                                                                       |
| `!…`           | reminder (for you)                            | `!30m` (30 minutes before the due time; also `!1h`, `!1d`), `!tomorrow 9am`, `!fri 8am` (at that time). Reminders before the due time need a task with a time                                                                                                    |

`#`, `@` and `/` open suggestions: use ↑ ↓ and Enter or Tab to pick one. Pasting several lines
adds one task per line, after you confirm.

## How dates are read

- **Weekdays** mean the next one, today included: on a Monday, `mon` is today. `next fri` is
  Friday of next week (weeks start on your chosen first day).
- **Dates without a year** mean the next time that date comes round.
- **Numbers like `3/4`** follow your date format setting: day first, or month first for
  month/day/year.
- **Bare numbers need `at`**: `at 5` is 05:00 (or 17:00 after `tonight`, `this evening`…),
  while a plain `5` stays text. Use `5pm` or `17:00` to be explicit.
- **Times of day**: `morning` 09:00, `afternoon` 14:00, `evening` 19:00, `night` 21:00.
- Short words that are also ordinary English (`sat`, `sun`, `wed`) need `on`, `next`, `this`
  or `every` in front. `daily`, `weekly`, `monthly` only count at the end of the name, so
  "Weekly review" stays a title.
- Turn date recognition off under **Settings → General** if you'd rather set dates by hand.

## Repeating tasks

Completing a repeating task moves it to the next date instead of finishing it, and reopens its
sub-tasks. An overdue daily task lands on today, not on the days you missed. `every!` counts
from the day you complete it. A series with an end date (`until …`) completes for good after
its last date. In the date picker, choosing a day moves just this occurrence; **Stop repeating**
keeps the date and drops the pattern.

Repeat rules are stored as a subset of iCalendar RRULE (`FREQ`, `INTERVAL`, `BYDAY` incl.
`2MO`/`-1FR`, `BYMONTHDAY`, `BYMONTH`, `UNTIL`, `WKST`), so the API accepts them directly.
