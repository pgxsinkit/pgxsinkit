import { createTheme } from "@mantine/core";

// The board's Mantine theme. Kept deliberately small — the demo's job is to show
// sync, not bespoke design. Status/priority colours live with their components.
export const theme = createTheme({
  primaryColor: "indigo",
  defaultRadius: "md",
  fontFamily: "Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
});
