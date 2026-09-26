// Began as a copy of `@electric-sql/pglite` (taken under its PostgreSQL License option, © ElectricSQL
// — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal — evolve freely.

const TemplateType = {
  part: "part",
  container: "container",
} as const;

/** A literal piece of SQL (an identifier or raw text) spliced into a template without a parameter. */
export interface TemplatePart {
  readonly _templateType: typeof TemplateType.part;
  readonly str: string;
}

/** A nested template: its strings and its parameter values. */
export interface TemplateContainer {
  readonly _templateType: typeof TemplateType.container;
  readonly strings: TemplateStringsArray;
  readonly values: unknown[];
}

/** A parametrized query: `$1`-numbered text and its parameters. */
export interface TemplatedQuery {
  readonly query: string;
  readonly params: unknown[];
}

function isTemplateValue(value: unknown): value is TemplatePart | TemplateContainer {
  return typeof value === "object" && value !== null && "_templateType" in value;
}

function addToLastAndPushWithSuffix(arr: string[], suffix: string, ...values: readonly string[]): void {
  const lastArrIdx = arr.length - 1;
  const lastValIdx = values.length - 1;
  if (lastValIdx === -1) return;
  if (lastValIdx === 0) {
    arr[lastArrIdx] = `${arr[lastArrIdx] ?? ""}${values[0] ?? ""}${suffix}`;
    return;
  }
  // Sandwich the values between the array's last element and the suffix.
  arr[lastArrIdx] = `${arr[lastArrIdx] ?? ""}${values[0] ?? ""}`;
  arr.push(...values.slice(1, lastValIdx));
  arr.push(`${values[lastValIdx] ?? ""}${suffix}`);
}

/**
 * Nest SQL templates without losing their parametrization:
 *
 * ```ts
 * pg.sql`SELECT * FROM tale ${withFilter ? sql`WHERE foo = ${fooVar}` : sql``}`
 * ```
 */
export function sql(strings: TemplateStringsArray, ...values: unknown[]): TemplateContainer {
  const parsedStrings: string[] = [strings[0] ?? ""];
  const parsedRaw: string[] = [strings.raw[0] ?? ""];
  const parsedValues: unknown[] = [];
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    const nextString = strings[i + 1] ?? "";
    const nextRaw = strings.raw[i + 1] ?? "";
    if (isTemplateValue(value) && value._templateType === TemplateType.part) {
      addToLastAndPushWithSuffix(parsedStrings, nextString, value.str);
      addToLastAndPushWithSuffix(parsedRaw, nextRaw, value.str);
      continue;
    }
    if (isTemplateValue(value) && value._templateType === TemplateType.container) {
      addToLastAndPushWithSuffix(parsedStrings, nextString, ...value.strings);
      addToLastAndPushWithSuffix(parsedRaw, nextRaw, ...value.strings.raw);
      parsedValues.push(...value.values);
      continue;
    }
    parsedStrings.push(nextString);
    parsedRaw.push(nextRaw);
    parsedValues.push(value);
  }
  const templateStrings = Object.assign(parsedStrings, { raw: parsedRaw });
  return { _templateType: TemplateType.container, strings: templateStrings, values: parsedValues };
}

/**
 * An identifier spliced into a template, double-quoted and not parametrized:
 *
 * ```ts
 * pg.sql`SELECT * FROM ${identifier`foo`} WHERE ${identifier`id`} = ${id}`
 * ```
 */
export function identifier(strings: TemplateStringsArray, ...values: unknown[]): TemplatePart {
  return { _templateType: TemplateType.part, str: `"${String.raw(strings, ...values)}"` };
}

/** Raw SQL spliced into a template as it is, neither parametrized nor escaped. */
export function raw(strings: TemplateStringsArray, ...values: unknown[]): TemplatePart {
  return { _templateType: TemplateType.part, str: String.raw(strings, ...values) };
}

/** Turn a template into `$1`-numbered query text and its parameters. */
export function query(strings: TemplateStringsArray, ...values: unknown[]): TemplatedQuery {
  const { strings: queryStringParts, values: params } = sql(strings, ...values);
  return {
    query: [queryStringParts[0], ...params.flatMap((_, idx) => [`$${idx + 1}`, queryStringParts[idx + 1]])].join(""),
    params,
  };
}
