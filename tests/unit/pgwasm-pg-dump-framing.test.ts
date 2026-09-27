import { describe, expect, it } from "bun:test";

import { ByteQueue, FrontendFramer } from "../../packages/pgwasm-pg-dump/src/framing";
import { dumpFile, withoutRestrictLines } from "../../packages/pgwasm-pg-dump/src/output";
import { serialize } from "../../packages/pgwasm/src/protocol";

// The byte plumbing between pg_dump's socket callbacks and the database's wire, and the output file.

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
};

const startup = serialize.startup({ user: "postgres", database: "postgres" });

describe("FrontendFramer", () => {
  it("hands over the startup packet, then typed messages, whole", () => {
    const framer = new FrontendFramer();
    const query = serialize.query("SELECT 1");
    expect(framer.push(startup)).toEqual([startup]);
    expect(framer.push(query)).toEqual([query]);
    expect(framer.pendingBytes).toBe(0);
  });

  it("holds a message sent in pieces until it is complete", () => {
    // libpq sends whole 8 KiB blocks and keeps the rest: a longer message arrives in several.
    const framer = new FrontendFramer();
    framer.push(startup);
    const query = serialize.query(`SELECT '${"x".repeat(12_000)}'`);
    expect(framer.push(query.subarray(0, 8192))).toEqual([]);
    expect(framer.push(query.subarray(8192, 8196))).toEqual([]);
    expect(framer.pendingBytes).toBe(8196);
    expect(framer.push(query.subarray(8196))).toEqual([query]);
    expect(framer.pendingBytes).toBe(0);
  });

  it("splits one send carrying several messages, keeping a trailing piece", () => {
    const framer = new FrontendFramer();
    const parse = serialize.parse({ text: "SELECT $1" });
    const bind = serialize.bind({ values: ["1"] });
    const execute = serialize.execute({});
    const sync = serialize.sync();
    const all = concat(startup, parse, bind, execute, sync);
    const cut = all.byteLength - 2;
    expect(framer.push(all.subarray(0, cut))).toEqual([startup, parse, bind, execute]);
    expect(framer.push(all.subarray(cut))).toEqual([sync]);
  });

  it("refuses a length shorter than the length field itself", () => {
    const framer = new FrontendFramer();
    framer.push(startup);
    expect(() => framer.push(new Uint8Array([0x51, 0, 0, 0, 3]))).toThrow(/invalid length/);
  });
});

describe("ByteQueue", () => {
  it("hands back bytes in whatever sizes are asked for, copying what it was given", () => {
    const queue = new ByteQueue();
    const first = new Uint8Array([1, 2, 3]);
    queue.push(first);
    queue.push(new Uint8Array([4, 5]));
    first[0] = 9;
    const target = new Uint8Array(2);
    expect(queue.read(target)).toBe(2);
    expect([...target]).toEqual([1, 2]);
    const rest = new Uint8Array(10);
    expect(queue.read(rest)).toBe(3);
    expect([...rest.subarray(0, 3)]).toEqual([3, 4, 5]);
    expect(queue.read(rest)).toBe(0);
  });
});

describe("the dump file", () => {
  const encode = (text: string) => new TextEncoder().encode(text);
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  const key = "8cCEAGsRMgsIyVj7gjA4meJIwFQQdpbw3BOx834r9uHigf5kVqSZBzWBSGC8Z4V";

  it("drops pg_dump's \\restrict and \\unrestrict lines, by their key", () => {
    const script = `--\n-- PostgreSQL database dump\n--\n\n\\restrict ${key}\n\nSET x = 1;\nINSERT INTO t VALUES ('a\n\\restrict other\n');\n\n\\unrestrict ${key}\n\n`;
    expect(decode(withoutRestrictLines(encode(script)))).toBe(
      `--\n-- PostgreSQL database dump\n--\n\n\nSET x = 1;\nINSERT INTO t VALUES ('a\n\\restrict other\n');\n\n\n`,
    );
  });

  it("leaves a script without them as it is", () => {
    const script = encode("SET x = 1;\n");
    expect(withoutRestrictLines(script)).toBe(script);
  });

  it("returns archives byte for byte", async () => {
    const custom = concat(encode("PGDMP"), new Uint8Array([1, 14, 0, 4]), encode(`\n\\restrict ${key}\n`));
    const gzip = new Uint8Array([0x1f, 0x8b, 8, 0, ...encode(`\n\\restrict ${key}\n`)]);
    for (const archive of [custom, gzip]) {
      const file = dumpFile(archive, "dump");
      expect(file.type).toBe("application/octet-stream");
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(archive);
    }
  });
});
