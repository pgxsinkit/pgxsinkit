import { useMediaQuery } from "@mantine/hooks";

/**
 * The one touch gate for the whole board (docs/mobile.md). It asks about CAPABILITIES — no hover, coarse
 * pointer — never viewport width: a narrow desktop window keeps every desktop affordance (drag, the kebab
 * menu, the SQL REPL), and a large tablet still gets the touch ones. `getInitialValueInEffect: false`
 * resolves the query during the first render, so a phone never paints the desktop branch and swaps it out
 * a frame later.
 */
export function useIsTouch(): boolean {
  return useMediaQuery("(hover: none) and (pointer: coarse)", false, { getInitialValueInEffect: false });
}
