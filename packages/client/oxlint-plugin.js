// Custom oxlint plugin for pgxsinkit's guarded-query surface (ADR-0021).
//
// The type split makes `use` structurally absent on the pure `client.query` / `queryRow` path (they take
// the builder callback directly). This rule catches the two provenance facts the type system cannot see:
//   A) a raw `sql` fragment smuggled into the pure path — the compiled-SQL scan can miss a lazy relation
//      named as a bare/unquoted identifier there, silently losing the guard; and
//   B) a `use` on the raw path (`queryRaw` / `useLiveQueryRaw`) whose builder is actually pure Drizzle — the
//      scan already detects every relation, so the `use` is redundant (autofixed away).
//
// Shipped with @pgxsinkit/client via the `./oxlint` subpath export, so consumers can enable it in their
// own oxlint config: `"jsPlugins": ["@pgxsinkit/client/oxlint"]` + `"pgxsinkit/guarded-query-purity": "error"`.
// Plain JS (not TS, and outside src/) on purpose: it is a tooling artifact loaded by oxlint at lint time,
// not part of the library's typed surface, so it is neither built nor typechecked nor self-linted.
//
// NOTE: this plugin has NO version logic — it runs under whatever oxlint loads it (1.72, 1.73, …), not
// only the version it was written against. But oxlint's jsPlugins feature is alpha and NOT semver-covered:
// the plugin API it relies on (create/context/report, ESTree node `.range`, `fixer.removeRange`) can
// change on a *minor* oxlint bump without that being flagged as breaking. That is why oxlint is pinned to
// an EXACT version in package.json (no `^`) — so upgrades are deliberate. On every oxlint bump, re-run
// lint and confirm this rule still loads and fires; adjust it here if the alpha API drifted.

const PURE_METHODS = new Set(["query", "queryRow"]);
const RAW_METHODS = new Set(["queryRaw", "queryRawRow", "useLiveQueryRaw", "useLiveQueryRawRow"]);

/** Depth-first visit of every descendant AST node. */
function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") visit(node);
  for (const key in node) {
    if (key === "parent") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) walk(item, visit);
    } else if (child && typeof child === "object") {
      walk(child, visit);
    }
  }
}

/** True if this build function embeds a raw SQL fragment: a ``sql`…` `` tagged template or `sql.raw(...)`. */
function usesRawSql(fn) {
  let found = false;
  walk(fn.body, (n) => {
    if (found) return;
    if (n.type === "TaggedTemplateExpression") {
      const tag = n.tag;
      if (tag && tag.type === "Identifier" && tag.name === "sql") found = true;
      else if (tag && tag.type === "MemberExpression" && tag.property && tag.property.name === "sql") found = true;
    } else if (n.type === "CallExpression") {
      const c = n.callee;
      if (
        c &&
        c.type === "MemberExpression" &&
        c.object &&
        c.object.name === "sql" &&
        c.property &&
        c.property.name === "raw"
      ) {
        found = true;
      }
    }
  });
  return found;
}

function isFunction(node) {
  return !!node && (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression");
}

const guardedQueryPurity = {
  meta: {
    type: "problem",
    fixable: "code",
    docs: { description: "Guard the pure/raw split of the pgxsinkit client query surface (ADR-0021)." },
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    return {
      CallExpression(node) {
        const callee = node.callee;
        const method =
          callee && callee.type === "MemberExpression"
            ? callee.property && callee.property.name
            : callee && callee.type === "Identifier"
              ? callee.name
              : undefined;
        if (!method || (!PURE_METHODS.has(method) && !RAW_METHODS.has(method))) return;

        const arg0 = node.arguments && node.arguments[0];
        let buildFn;
        let useProp;
        if (isFunction(arg0)) {
          buildFn = arg0; // pure callback form: query(fn) / queryRow(fn)
        } else if (arg0 && arg0.type === "ObjectExpression") {
          for (const p of arg0.properties) {
            if (p.type !== "Property" || !p.key) continue;
            if (p.key.name === "build") buildFn = p.value;
            else if (p.key.name === "use") useProp = p;
          }
        }
        if (!isFunction(buildFn)) return;

        const raw = usesRawSql(buildFn);

        // A) raw sql on the PURE path — the scan can miss a bare identifier → a real safety hole.
        if (PURE_METHODS.has(method) && raw) {
          const rawEquivalent = method === "queryRow" ? "queryRawRow" : "queryRaw";
          context.report({
            node: buildFn,
            message:
              `${method}() is the pure-Drizzle path but its build() embeds a raw \`sql\` fragment, which the ` +
              `lazy-relation scan can miss (a bare identifier). Use client.${rawEquivalent}({ use, build }) and ` +
              `declare the lazy relations in \`use\` (ADR-0021).`,
          });
          return;
        }

        // B) `use` on the raw path with a pure build — redundant. Autofix: drop the `use` property.
        if (RAW_METHODS.has(method) && useProp && !raw) {
          context.report({
            node: useProp,
            message:
              "`use` is redundant here: build() is pure Drizzle, so the compiled-SQL scan detects every " +
              "relation it reads. Drop `use` and prefer the pure query method (ADR-0021).",
            fix(fixer) {
              const text = sourceCode.getText();
              const start = useProp.range[0];
              let end = useProp.range[1];
              while (end < text.length && /\s/.test(text[end])) end++;
              if (text[end] === ",") end++;
              return fixer.removeRange([start, end]);
            },
          });
        }
      },
    };
  },
};

export default {
  meta: { name: "pgxsinkit" },
  rules: { "guarded-query-purity": guardedQueryPurity },
};
