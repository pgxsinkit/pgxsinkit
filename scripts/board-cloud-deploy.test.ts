import { describe, expect, test } from "bun:test";

import {
  boardFrontendCloudEnv,
  boardSupabaseFunctionsArgs,
  boardSupabaseProject,
  boardSupabaseCliEnv,
  boardSupabaseSecretsArgs,
} from "./board-cloud-deploy";

const env = {
  BOARD_SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst",
  BOARD_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
  BOARD_SUPABASE_ACCESS_TOKEN: "sbp_board_account_token",
};

describe("board cloud project targeting", () => {
  test("derives the compiled frontend environment without exposing server secrets", () => {
    expect(
      boardFrontendCloudEnv({
        ...env,
        BOARD_PUBLISHABLE_KEY: "sb_publishable_board",
        BOARD_FUNCTIONS_REGION: "eu-central-1",
        BOARD_SECRET_KEY: "must-not-leak",
      }),
    ).toEqual({
      VITE_BOARD_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
      VITE_BOARD_PUBLISHABLE_KEY: "sb_publishable_board",
      VITE_BOARD_FUNCTIONS_REGION: "eu-central-1",
    });
  });

  test("derives the standard URL from the authoritative project ref", () => {
    expect(boardSupabaseProject({ ...env, BOARD_SUPABASE_URL: "" })).toEqual({
      ref: "abcdefghijklmnopqrst",
      url: "https://abcdefghijklmnopqrst.supabase.co",
    });
  });

  test("passes the project ref to every mutating Supabase CLI command", () => {
    expect(boardSupabaseSecretsArgs(env, "tmp/agents/secret.env")).toEqual([
      "secrets",
      "set",
      "--project-ref",
      "abcdefghijklmnopqrst",
      "--env-file",
      "tmp/agents/secret.env",
    ]);
    expect(boardSupabaseFunctionsArgs(env)).toEqual([
      "functions",
      "deploy",
      "--project-ref",
      "abcdefghijklmnopqrst",
      "board-write",
      "board-sync",
    ]);
    expect(boardSupabaseCliEnv(env)).toEqual({
      SUPABASE_ACCESS_TOKEN: "sbp_board_account_token",
    });
  });

  test("requires the board account's own access token", () => {
    expect(() => boardSupabaseCliEnv({ ...env, BOARD_SUPABASE_ACCESS_TOKEN: "" })).toThrow(
      "needs a real BOARD_SUPABASE_ACCESS_TOKEN",
    );
  });

  test("rejects a standard URL belonging to another project", () => {
    expect(() =>
      boardSupabaseProject({
        ...env,
        BOARD_SUPABASE_URL: "https://zyxwvutsrqponmlkjihg.supabase.co",
      }),
    ).toThrow("does not match BOARD_SUPABASE_PROJECT_REF");
  });
});
