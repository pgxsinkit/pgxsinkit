// Began as a copy of `@electric-sql/pglite-repl` (taken under PGlite's PostgreSQL License option,
// © ElectricSQL — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal.

import { defaultKeymap } from "@codemirror/commands";
import { PostgreSQL } from "@codemirror/lang-sql";
import { keymap } from "@codemirror/view";
import { githubDark, githubDarkInit, githubLight, githubLightInit } from "@uiw/codemirror-theme-github";
import type { CreateThemeOptions } from "@uiw/codemirror-themes";
import CodeMirror, { type Extension, type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { ReplResponseView } from "./repl-response";
import { getSchema, runQuery } from "./run-query";
import { sqlSupport } from "./sql-support";
import { REPL_STYLES, REPL_STYLESHEET_ID } from "./styles";
import type { ReplDatabase, ReplResponse } from "./types";

// Enter runs the input, so it is taken out of the default keymap. Up and Down keep their default except
// on the first and last line, where they walk the history.
const baseKeymap = defaultKeymap.filter((binding) => binding.key !== "Enter");

export type ReplTheme = "light" | "dark" | "auto";

type ThemeInit = (options?: Partial<CreateThemeOptions>) => Extension;

export const defaultLightThemeInit: ThemeInit = githubLightInit;
export const defaultLightTheme: Extension = githubLight;
export const defaultDarkThemeInit: ThemeInit = githubDarkInit;
export const defaultDarkTheme: Extension = githubDark;

export interface ReplProps {
  /** The database: a `Pgwasm`, or anything with its `query` and `exec` (`replAdapter(client)`). */
  readonly pg: ReplDatabase;
  /** An outer border. Defaults to false. */
  readonly border?: boolean;
  readonly lightTheme?: Extension;
  readonly darkTheme?: Extension;
  /** `auto` follows the system's colour scheme. Defaults to `auto`. */
  readonly theme?: ReplTheme;
  /** Show how long each input took. Defaults to false. */
  readonly showTime?: boolean;
  /** Do not re-read the tables for autocompletion after each input. Defaults to false. */
  readonly disableUpdateSchema?: boolean;
}

const prefersDark = () => globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches === true;

/** An interactive SQL prompt on a database: psql's `\d` commands, autocompletion, input history. */
export function Repl({
  pg,
  border = false,
  lightTheme = defaultLightTheme,
  darkTheme = defaultDarkTheme,
  theme = "auto",
  showTime = false,
  disableUpdateSchema = false,
}: ReplProps) {
  const [value, setValue] = useState("");
  // What was typed before walking the history, and where in the history the input is (-1: not in it).
  const [valueBeforeHistory, setValueBeforeHistory] = useState("");
  const [historyPosition, setHistoryPosition] = useState(-1);
  const [readyPg, setReadyPg] = useState<ReplDatabase | undefined>(undefined);
  const loading = readyPg !== pg;
  const [output, setOutput] = useState<ReplResponse[]>([]);
  const outputRef = useRef<HTMLDivElement | null>(null);
  const [schema, setSchema] = useState<Record<string, string[]>>({});
  const editorRef = useRef<ReactCodeMirrorRef | null>(null);
  const [systemDark, setSystemDark] = useState(prefersDark);
  const themeToUse = theme === "dark" || (theme === "auto" && systemDark) ? darkTheme : lightTheme;
  const [styles, setStyles] = useState<Record<string, string>>({});

  const refreshSchema = useCallback(() => {
    getSchema(pg).then(
      setSchema,
      // Autocompletion keeps the tables it had.
      () => undefined,
    );
  }, [pg]);

  // The editor's colours and borders, applied to the whole REPL.
  const extractStyles = useCallback(() => {
    const editor = editorRef.current?.editor?.querySelector(".cm-editor");
    const gutters = editor?.querySelector(".cm-gutters");
    if (!editor || !gutters) return;
    const editorStyle = globalThis.getComputedStyle(editor);
    const gutterStyle = globalThis.getComputedStyle(gutters);
    const foreground = editorStyle.color;
    const borderWidth = Number.parseInt(gutterStyle.borderRightWidth, 10) || 0;
    const borderColor = borderWidth
      ? gutterStyle.borderRightColor
      : foreground.replace("rgb", "rgba").replace(")", ", 0.15)");
    setStyles({
      "--pgwasm-repl-foreground-color": foreground,
      "--pgwasm-repl-background-color": editorStyle.backgroundColor,
      "--pgwasm-repl-border": borderWidth ? gutterStyle.borderRight : `1px solid ${borderColor}`,
      "--pgwasm-repl-gutter-border": gutterStyle.borderRight,
      "--pgwasm-repl-border-color": borderColor,
    });
  }, []);

  useEffect(() => {
    let ignore = false;
    (pg.waitReady ?? Promise.resolve()).then(
      () => {
        if (!ignore) setReadyPg(pg);
      },
      () => undefined,
    );
    return () => {
      ignore = true;
    };
  }, [pg]);

  // Follow the system's colour scheme.
  useEffect(() => {
    if (theme !== "auto") return;
    const query = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
    if (query === undefined) return;
    const listener = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }, [theme]);

  // Once a theme is applied, take its colours.
  useEffect(() => {
    const timer = setTimeout(extractStyles, 0);
    return () => clearTimeout(timer);
  }, [themeToUse, extractStyles]);

  // Keep the latest response in view.
  useEffect(() => {
    const element = outputRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [output]);

  const onChange = useCallback(
    (next: string) => {
      extractStyles();
      setValue(next);
      if (historyPosition === -1) setValueBeforeHistory(next);
    },
    [extractStyles, historyPosition],
  );

  const extensions = useMemo(() => {
    const moveHistory = (step: number): boolean => {
      const next = Math.max(-1, Math.min(output.length - 1, historyPosition + step));
      if (next !== historyPosition) {
        setHistoryPosition(next);
        setValue(next === -1 ? valueBeforeHistory : (output[output.length - next - 1]?.query ?? ""));
      }
      return true;
    };
    return [
      keymap.of([
        {
          key: "Enter",
          preventDefault: true,
          run: () => {
            if (value.trim() === "") return false;
            void runQuery(value, pg).then((response) => {
              setOutput((previous) => [...previous, response]);
              // New tables become autocompletion candidates.
              if (!disableUpdateSchema) refreshSchema();
            });
            setHistoryPosition(-1);
            setValueBeforeHistory("");
            setValue("");
            return true;
          },
        },
        {
          key: "ArrowUp",
          run: (view) => {
            const state = view.state;
            if (state.doc.lineAt(state.selection.main.head).number !== 1) return false;
            return moveHistory(1);
          },
        },
        {
          key: "ArrowDown",
          run: (view) => {
            const state = view.state;
            if (state.doc.lineAt(state.selection.main.head).number !== state.doc.lines) return false;
            return moveHistory(-1);
          },
        },
        ...baseKeymap,
      ]),
      sqlSupport({
        dialect: PostgreSQL,
        schema,
        tables: [{ label: "d", displayLabel: "\\d" }],
        defaultSchema: "public",
      }),
    ];
  }, [pg, schema, value, valueBeforeHistory, historyPosition, output, disableUpdateSchema, refreshSchema]);

  return (
    <div
      className={border ? "pgwasm-repl-root pgwasm-repl-root-border" : "pgwasm-repl-root"}
      style={styles as CSSProperties}
    >
      {/* React inserts this into the document's head once, however many REPLs render it. */}
      <style href={REPL_STYLESHEET_ID} precedence="default">
        {REPL_STYLES}
      </style>
      <div className="pgwasm-repl-output" ref={outputRef}>
        {loading && <div className="pgwasm-repl-loading-msg">Loading...</div>}
        {output.map((response, index) => (
          // An input keeps its place in the history; the same text can be entered twice.
          <div key={index}>
            <ReplResponseView response={response} showTime={showTime} />
          </div>
        ))}
      </div>
      <CodeMirror
        ref={editorRef}
        className={loading ? "pgwasm-repl-input pgwasm-repl-input-loading" : "pgwasm-repl-input"}
        width="100%"
        value={value}
        basicSetup={{ defaultKeymap: false }}
        extensions={extensions}
        theme={themeToUse}
        onChange={onChange}
        editable={!loading}
        onCreateEditor={() => {
          extractStyles();
          refreshSchema();
        }}
      />
    </div>
  );
}
