# @pgxsinkit/pgwasm-repl

An interactive SQL prompt, as a React component, for a
[`@pgxsinkit/pgwasm`](https://www.npmjs.com/package/@pgxsinkit/pgwasm) database or a pgxsinkit
client: [CodeMirror](https://codemirror.net) input with autocompletion of keywords, tables and
columns, input history (Up and Down), and psql's `\d` family of commands (through
[psql-describe](https://www.npmjs.com/package/psql-describe)).

```bash
bun add @pgxsinkit/pgwasm-repl
```

It needs React 19.3 or later (`react` and `react-dom`).

```tsx
import { createPgwasm } from "@pgxsinkit/pgwasm";
import { cBuild } from "@pgxsinkit/pgwasm-c";
import { Repl } from "@pgxsinkit/pgwasm-repl";

const pg = await createPgwasm({ build: cBuild });

export function Console() {
  return <Repl pg={pg} />;
}
```

Enter runs the input. Everything else typed is SQL; a line starting with a backslash is a psql
describe command, such as `\dt` or `\d my_table`.

## The database

`pg` is required. It is anything with pgwasm's `query` and `exec` (the `ReplDatabase` type): a
`Pgwasm`, or a pgxsinkit client's inspection surface through `replAdapter(client)` from
`@pgxsinkit/client`, which works on a worker-attached client too. When `pg` has a `waitReady`
promise, the prompt waits for it.

## Props

| Prop                  | Default      | What it does                                                          |
| --------------------- | ------------ | --------------------------------------------------------------------- |
| `pg`                  | (required)   | the database                                                          |
| `border`              | `false`      | an outer border                                                       |
| `theme`               | `"auto"`     | `"light"`, `"dark"`, or `"auto"` to follow the system's colour scheme |
| `lightTheme`          | GitHub light | a CodeMirror theme extension                                          |
| `darkTheme`           | GitHub dark  | a CodeMirror theme extension                                          |
| `showTime`            | `false`      | show how long each input took                                         |
| `disableUpdateSchema` | `false`      | do not re-read the tables for autocompletion after each input         |

The GitHub themes are exported as `defaultLightTheme` and `defaultDarkTheme`, with
`defaultLightThemeInit` and `defaultDarkThemeInit` to make variants of them.

## Styling

The component brings its own stylesheet: React adds it to the page once, however many prompts are
mounted, so there is no CSS file to import. It fills its container. Its classes start with
`pgwasm-repl-`, and `--pgwasm-repl-font-size` (12px by default) sets its text size; the colours come
from the editor's theme.

Licensed under the MIT License. `NOTICE` records the component's origin in ElectricSQL's PGlite REPL.
