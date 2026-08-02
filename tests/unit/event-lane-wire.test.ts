import { describe, expect, it } from "bun:test";

import {
  batchEventAckSchema,
  batchEventErrorSchema,
  batchEventPaths,
  batchEventRequestSchema,
  eventAckSchema,
  eventEnvelopeSchema,
  eventQueueMessageSchema,
  MAX_EVENT_PAYLOAD_BYTES,
  MAX_EVENT_REQUEST_BYTES,
  MAX_EVENTS_PER_BATCH,
  stampedEventSchema,
} from "@pgxsinkit/contracts";

// The Event lane's wire contracts (ADR-0053 decision 3 + 5): the flush endpoint's request/verdict bodies and
// the stamped queue envelope. Strict everywhere the mutation path is strict — an unknown key is a framing
// fault, not something to silently drop.

const eventId = "0b6b2a6e-2a3d-4d6d-9f2a-1a5f2c3d4e5f";
const occurredAtUs = "1754006400000000";

const envelope = () => ({ stream: "board_issue_viewed", eventId, occurredAtUs, payload: { issueId: eventId } });

describe("eventEnvelopeSchema (ADR-0053 decision 3)", () => {
  it("accepts a library-built envelope", () => {
    expect(eventEnvelopeSchema.safeParse(envelope()).success).toBe(true);
  });

  it("requires a uuid eventId", () => {
    expect(eventEnvelopeSchema.safeParse({ ...envelope(), eventId: "not-a-uuid" }).success).toBe(false);
  });

  it("requires occurredAtUs as unix-microsecond digits (the clientTimestampUs treatment)", () => {
    expect(eventEnvelopeSchema.safeParse({ ...envelope(), occurredAtUs: 1754006400000000 }).success).toBe(false);
    expect(eventEnvelopeSchema.safeParse({ ...envelope(), occurredAtUs: "2026-08-01" }).success).toBe(false);
  });

  it("requires a non-empty stream name", () => {
    expect(eventEnvelopeSchema.safeParse({ ...envelope(), stream: "" }).success).toBe(false);
  });

  it("rejects an unknown key (strict) — including a client-supplied identity", () => {
    expect(eventEnvelopeSchema.safeParse({ ...envelope(), identity: { viewerId: "someone" } }).success).toBe(false);
    expect(eventEnvelopeSchema.safeParse({ ...envelope(), seq: 12 }).success).toBe(false);
  });
});

describe("batchEventRequestSchema (ADR-0053 decision 3)", () => {
  it("accepts a batch and rejects an empty one", () => {
    expect(batchEventRequestSchema.safeParse({ events: [envelope()] }).success).toBe(true);
    expect(batchEventRequestSchema.safeParse({ events: [] }).success).toBe(false);
  });

  it("enforces MAX_EVENTS_PER_BATCH", () => {
    const atCap = Array.from({ length: MAX_EVENTS_PER_BATCH }, envelope);
    expect(batchEventRequestSchema.safeParse({ events: atCap }).success).toBe(true);
    expect(batchEventRequestSchema.safeParse({ events: [...atCap, envelope()] }).success).toBe(false);
  });

  it("rejects an unknown key (strict)", () => {
    expect(batchEventRequestSchema.safeParse({ events: [envelope()], mutations: [] }).success).toBe(false);
  });

  it("pins the request-shape limits as deliberate toolkit constants", () => {
    expect(MAX_EVENTS_PER_BATCH).toBe(1000);
    expect(MAX_EVENT_PAYLOAD_BYTES).toBe(64 * 1024);
    expect(MAX_EVENT_REQUEST_BYTES).toBe(4 * 1024 * 1024);
    // The body cap binds before a full batch of maximal payloads could.
    expect(MAX_EVENTS_PER_BATCH * MAX_EVENT_PAYLOAD_BYTES).toBeGreaterThan(MAX_EVENT_REQUEST_BYTES);
    expect(batchEventPaths).toEqual(["/api/events"]);
  });
});

describe("verdict bodies (ADR-0053 decision 3)", () => {
  it("accepts each of the four verdicts and rejects anything else", () => {
    for (const status of ["acked", "refused", "rejected", "deferred"]) {
      expect(eventAckSchema.safeParse({ eventId, status }).success).toBe(true);
    }
    expect(eventAckSchema.safeParse({ eventId, status: "conflicted" }).success).toBe(false);
    expect(eventAckSchema.safeParse({ eventId, status: "acked", reason: "gated" }).success).toBe(true);
    expect(eventAckSchema.safeParse({ eventId, status: "acked", reason: "" }).success).toBe(false);
    expect(eventAckSchema.safeParse({ eventId: "nope", status: "acked" }).success).toBe(false);
    expect(eventAckSchema.safeParse({ eventId, status: "acked", extra: 1 }).success).toBe(false);
  });

  it("accepts an ack batch (including the empty-acks edge) and rejects unknown keys", () => {
    expect(batchEventAckSchema.safeParse({ acks: [{ eventId, status: "acked" }] }).success).toBe(true);
    expect(batchEventAckSchema.safeParse({ acks: [] }).success).toBe(true);
    expect(batchEventAckSchema.safeParse({ acks: [], rejections: [] }).success).toBe(false);
  });

  it("carries only a message on the error body — framing faults are batch-level, never per-event", () => {
    expect(batchEventErrorSchema.safeParse({ message: "payload too large" }).success).toBe(true);
    expect(batchEventErrorSchema.safeParse({}).success).toBe(true);
    // Non-strict like its mutation twin: unknown keys are stripped, not rejected.
    const parsed = batchEventErrorSchema.parse({ message: "nope", rejections: [{ eventId }] });
    expect(parsed).toEqual({ message: "nope" });
  });
});

describe("the stamped envelope (ADR-0053 decision 5)", () => {
  const stamped = () => ({ eventId, occurredAtUs, identity: { viewerId: "someone" }, payload: { issueId: eventId } });

  it("accepts a server-stamped event", () => {
    expect(stampedEventSchema.safeParse(stamped()).success).toBe(true);
    expect(stampedEventSchema.safeParse({ ...stamped(), identity: {} }).success).toBe(true);
  });

  it("rejects a stamped event that smuggles the stream or an unknown key (strict)", () => {
    expect(stampedEventSchema.safeParse({ ...stamped(), stream: "board_issue_viewed" }).success).toBe(false);
  });

  it("requires identity values to be strings under non-empty field names", () => {
    expect(stampedEventSchema.safeParse({ ...stamped(), identity: { viewerId: 7 } }).success).toBe(false);
    expect(stampedEventSchema.safeParse({ ...stamped(), identity: { "": "someone" } }).success).toBe(false);
  });

  it("carries one single-stream sub-batch per queue message", () => {
    expect(eventQueueMessageSchema.safeParse({ stream: "board_issue_viewed", events: [stamped()] }).success).toBe(true);
    expect(eventQueueMessageSchema.safeParse({ stream: "board_issue_viewed", events: [] }).success).toBe(false);
    expect(eventQueueMessageSchema.safeParse({ stream: "", events: [stamped()] }).success).toBe(false);
    expect(
      eventQueueMessageSchema.safeParse({ stream: "board_issue_viewed", events: [stamped()], acks: [] }).success,
    ).toBe(false);
  });
});
