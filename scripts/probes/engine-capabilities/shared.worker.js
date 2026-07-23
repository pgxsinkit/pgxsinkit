// SharedWorker body for the engine-capability probes (plain JS).
// Handles P2 (SharedWorker sync-access grant) and P3 (nested worker spawn).
"use strict";

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

async function runP2(port) {
  var present = methodPresent();
  try {
    var root = await navigator.storage.getDirectory();
    var fh = await root.getFileHandle("p2-shared.bin", { create: true });
    var ah = await fh.createSyncAccessHandle();
    ah.close();
    port.postMessage({ p2: { granted: true, methodPresent: present } });
  } catch (err) {
    port.postMessage({ p2: { granted: false, methodPresent: present, error: describeError(err) } });
  }
}

function runP3(port) {
  // P3: can a SharedWorker spawn a nested dedicated Worker at all? Spawn one, ask it
  // to run P1, and report whether it responded.
  var nested;
  try {
    nested = new Worker("./dedicated.worker.js");
  } catch (err) {
    port.postMessage({ p3: { spawned: false, error: describeError(err) } });
    return;
  }
  var settled = false;
  var timer = setTimeout(function () {
    if (settled) {
      return;
    }
    settled = true;
    try {
      nested.terminate();
    } catch {
      /* best-effort */
    }
    port.postMessage({ p3: { spawned: true, nestedResponded: false, note: "no response within timeout" } });
  }, 10000);
  nested.onmessage = function () {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    nested.terminate();
    port.postMessage({ p3: { spawned: true, nestedResponded: true } });
  };
  nested.onerror = function (e) {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    try {
      nested.terminate();
    } catch {
      /* best-effort */
    }
    port.postMessage({ p3: { spawned: true, nestedResponded: false, nestedError: (e && e.message) || "error" } });
  };
  nested.postMessage({ cmd: "p1" });
}

function handleMessage(msg, port) {
  if (!msg || !msg.cmd) {
    return;
  }
  if (msg.cmd === "p2") {
    void runP2(port);
  } else if (msg.cmd === "p3") {
    runP3(port);
  }
}

self.onconnect = function (e) {
  var port = e.ports[0];
  port.onmessage = function (ev) {
    handleMessage(ev.data, port);
  };
  if (typeof port.start === "function") {
    port.start();
  }
};
