# Filters

A filter is a saved query over your open tasks, written in the same language as Todoist's
filters. Make one under **Filters & Labels → +**; the editor checks it as you type and shows how
many tasks match.

```
(today | overdue) & ##Work, @phone
```

## Terms

| Term                                                                    | Matches                                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------------ |
| `today`, `tomorrow`, `yesterday`                                        | Due that day                                                 |
| `overdue` (`od`)                                                        | Due before today, or earlier today at a time that has passed |
| `7 days`, `next 7 days`, `2 weeks`                                      | Due from today through the next 6 days (or 13)               |
| `-7 days`                                                               | Due in the 7 days before today                               |
| `this week`, `next week`, `this month`, `next month`                    | Due in that week or month (weeks start on your chosen day)   |
| `friday`, `jan 3`, `27/10`, `next fri`                                  | Due on that day (any date quick add understands)             |
| `due: …`, `due before: …`, `due after: …`                               | Due on, before or after a date (`date:` works too)           |
| `deadline: …`, `deadline before: …`, `deadline after: …`, `no deadline` | By deadline                                                  |
| `created: …`, `created before: …`, `created after: …`                   | By the day the task was created, in your time zone           |
| `no date`, `no time`, `recurring`                                       | Without a date, dated without a time, repeating              |
| `p1` … `p4`, `no priority`                                              | Priority                                                     |
| `#Work`                                                                 | In the project Work                                          |
| `##Work`                                                                | In Work or any of its sub-projects                           |
| `/Next up`, `/*`                                                        | In a section of that name (any project), in any section      |
| `@errands`, `no labels`                                                 | With the label, without labels                               |
| `search: invoice`                                                       | Task name contains the text (case-insensitive)               |
| `assigned to: me`, `assigned to: others`, `assigned`, `unassigned`      | By assignee                                                  |
| `assigned by: me`, `assigned by: others`                                | By who assigned it                                           |
| `subtask`                                                               | Sub-tasks only (`!subtask`: top-level only)                  |
| `all` (`view all`)                                                      | Every open task                                              |

Names are case-insensitive, may contain spaces, and accept `*` as a wildcard: `#Client*`,
`@home*`, `@*` (any label). A name that matches nothing shows a note instead of failing, so a
filter keeps working after a project is renamed back or shared with you.

## Combining

| Operator            | Meaning                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| `&`                 | and                                                                                                           |
| <code>&#124;</code> | or (`&` binds tighter: <code>today &#124; overdue & p1</code> means <code>today &#124; (overdue & p1)</code>) |
| `!`                 | not                                                                                                           |
| `( )`               | grouping                                                                                                      |
| `,`                 | separate lists, shown one after another (or as board columns)                                                 |

To use `& | ( ) ,` inside a name or search, put a backslash before it: `#Q4 \(Launch\)`.

Limits: 1,024 characters, 64 terms, 10 lists, 16 levels of nesting.

## Not yet

`shared`, `workspace:` and assignee names (`assigned to: Sam`) arrive with collaboration (W5).
Completed tasks aren't searched by filters; use search for those.

## API

`GET /api/v1/tasks/filter?query=…&limit=…` runs a filter on the server and returns
`{ lists: [{ query, tasks }], warnings }`, or `400 { error: "invalid_filter", message, start, end }`.
The server and the apps use the same parser, and a test checks they return identical tasks.
