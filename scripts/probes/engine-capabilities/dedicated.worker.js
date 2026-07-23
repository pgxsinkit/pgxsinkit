// Dedicated-worker body for the engine-capability probes (plain JS classic worker).
// Handles P1 (grant), P4 hold/contend (held-handle contention), and P5 (handle ceiling).
"use strict";

var held = null; // sync access handle kept open for the P4 "hold" role.

function describeError(err) {
  if (!err) {
    return { name: null, message: null };
  }
  return { name: err.name || null, message: err.message || String(err) };
}

function methodPresent() {
  return (
    typeof FileSystemFileHandle !== "undefined" &&
    typeof FileSystemFileHandle.prototype.createSyncAccessHandle === "function"
  );
}

async function runP1() {
  var present = methodPresent();
  try {
    var root = await navigator.storage.getDirectory();
    var fh = await root.getFileHandle("p1.bin", { create: true });
    var ah = await fh.createSyncAccessHandle();
    ah.close();
    self.postMessage({ granted: true, methodPresent: present });
  } catch (err) {
    self.postMessage({ granted: false, methodPresent: present, error: describeError(err) });
  }
}

async function runHold(file) {
  try {
    var root = await navigator.storage.getDirectory();
    var fh = await root.getFileHandle(file, { create: true });
    held = await fh.createSyncAccessHandle();
    self.postMessage({ holding: true });
  } catch (err) {
    self.postMessage({ holding: true, holdError: describeError(err) });
  }
}

function runRelease() {
  if (held) {
    try {
      held.close();
    } catch {
      /* best-effort close */
    }
    held = null;
  }
  self.postMessage({ released: true });
}

async function runContend(file) {
  try {
    var root = await navigator.storage.getDirectory();
    var fh = await root.getFileHandle(file, { create: true });
    var ah = await fh.createSyncAccessHandle();
    // Unexpected: contention did not throw. Record it and clean up.
    ah.close();
    self.postMessage({ contended: true, acquired: true });
  } catch (err) {
    self.postMessage({ contended: true, acquired: false, error: describeError(err) });
  }
}

async function runP5(count, watchdogMs) {
  var handles = [];
  var root = await navigator.storage.getDirectory();
  for (var i = 0; i < count; i++) {
    var fh = await root.getFileHandle("probe-" + i + ".bin", { create: true });
    var timer = null;
    var watchdog = new Promise(function (_resolve, reject) {
      timer = setTimeout(function () {
        reject(new Error("__WATCHDOG__"));
      }, watchdogMs);
    });
    try {
      var ah = await Promise.race([fh.createSyncAccessHandle(), watchdog]);
      clearTimeout(timer);
      handles.push(ah);
      if (i % 25 === 0) {
        self.postMessage({ p5progress: i + 1 });
      }
    } catch (err) {
      clearTimeout(timer);
      if (err && err.message === "__WATCHDOG__") {
        // Acquisition neither resolved nor rejected within the watchdog: stalled.
        // Leave the open handles as-is; the underlying browser may be wedged.
        self.postMessage({
          p5: { classification: "stalled", count: i, openedBefore: handles.length, watchdogMs: watchdogMs },
        });
        return;
      }
      // Clean rejection at count i.
      for (var j = 0; j < handles.length; j++) {
        try {
          handles[j].close();
        } catch {
          /* best-effort close */
        }
      }
      self.postMessage({
        p5: { classification: "rejected", count: i, openedBefore: handles.length, error: describeError(err) },
      });
      return;
    }
  }
  // All requested handles were acquired without a ceiling.
  self.postMessage({ p5: { classification: "uncapped", count: count, openedBefore: handles.length } });
  for (var k = 0; k < handles.length; k++) {
    try {
      handles[k].close();
    } catch {
      /* best-effort close */
    }
  }
}

async function handleMessage(msg) {
  try {
    if (!msg || !msg.cmd) {
      self.postMessage({ fatal: { name: "BadMessage", message: "missing cmd" } });
      return;
    }
    switch (msg.cmd) {
      case "p1":
        await runP1();
        break;
      case "hold":
        await runHold(msg.file);
        break;
      case "release":
        runRelease();
        break;
      case "contend":
        await runContend(msg.file);
        break;
      case "p5":
        await runP5(msg.count, msg.watchdogMs);
        break;
      default:
        self.postMessage({ fatal: { name: "BadMessage", message: "unknown cmd " + msg.cmd } });
    }
  } catch (err) {
    self.postMessage({ fatal: describeError(err) });
  }
}

self.onmessage = function (e) {
  handleMessage(e.data).catch(function (err) {
    self.postMessage({ fatal: describeError(err) });
  });
};
