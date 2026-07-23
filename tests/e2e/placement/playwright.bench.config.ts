import base from "./playwright.config";

export default {
  ...base,
  testMatch: "**/provision-cold-boot.bench.ts",
  projects: base.projects?.filter((project) => project.name === "chromium"),
};
