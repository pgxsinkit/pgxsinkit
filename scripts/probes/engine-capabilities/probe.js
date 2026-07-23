// Browser-side engine-capability probe suite (plain JS, no build step).
//
// Loaded by index.html. Runs one of two modes selected by the `mode` query param:
//   ?mode=core  -> P1 (dedicated-worker grant), P2 (SharedWorker grant),
//                  P3 (nested worker from a SharedWorker), P4 (held-handle contention)
//   ?mode=p5    -> P5 (handle ceiling) ONLY, so a wedge cannot poison the P1-P4 run
//
// The accumulated result object is published on `window.__PROBE_RESULTS__`, and
// `window.__PROBE_DONE__` flips to true when the suite finishes. The Playwright
// driver (run.ts) awaits that flag and reads the results. P5 progress is mirrored
// on `window.__PROBE_P5_PARTIAL__` so the driver can classify a genuine wedge that
// never reaches the done flag.
"use strict";

(function () {
  var results = { startedAt: new Date().toISOString() };
  window.__PROBE_RESULTS__ = results;
  window.__PROBE_DONE__ = false;
  window.__PROBE_P5_PARTIAL__ = null;

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

  function opfsSupported() {
    return (
      typeof navigator !== "undefined" && !!navigator.storage && typeof navigator.storage.getDirectory === "function"
    );
  }

  function finish() {
    window.__PROBE_RESULTS__ = results;
    window.__PROBE_DONE__ = true;
    var status = document.getElementById("status");
    if (status) {
      status.textContent = "done";
    }
    var out = document.getElementById("out");
    if (out) {
      out.textContent = JSON.stringify(results, null, 2);
    }
  }

  // Remove every entry under the origin's OPFS root so each run starts fresh.
  function resetOpfs() {
    if (!opfsSupported()) {
      return Promise.resolve(false);
    }
    return navigator.storage.getDirectory().then(function (root) {
      var names = [];
      return (async function () {
        for await (var entry of root.entries()) {
          names.push(entry[0]);
        }
        for (var i = 0; i < names.length; i++) {
          await root.removeEntry(names[i], { recursive: true });
        }
        return true;
      })();
    });
  }

  // P1 / P4-A / P4-B / P5 all run inside dedicated.worker.js. This helper drives a
  // single request/response exchange and then terminates the worker.
  function askDedicated(command, extra) {
    return new Promise(function (resolve) {
      var w = new Worker("./dedicated.worker.js");
      var timer = setTimeout(function () {
        w.terminate();
        resolve({ timeout: true });
      }, 20000);
      w.onmessage = function (e) {
        clearTimeout(timer);
        w.terminate();
        resolve(e.data);
      };
      w.onerror = function (e) {
        clearTimeout(timer);
        w.terminate();
        resolve({ workerError: (e && e.message) || "worker error" });
      };
      var msg = { cmd: command };
      if (extra) {
        Object.keys(extra).forEach(function (k) {
          msg[k] = extra[k];
        });
      }
      w.postMessage(msg);
    });
  }

  // P2 (SharedWorker grant) and P3 (nested worker from a SharedWorker) run inside
  // shared.worker.js.
  function askShared(command) {
    return new Promise(function (resolve) {
      if (typeof SharedWorker === "undefined") {
        resolve({ sharedWorkerSupported: false });
        return;
      }
      var sw;
      try {
        sw = new SharedWorker("./shared.worker.js");
      } catch (err) {
        resolve({ sharedWorkerSupported: false, constructError: describeError(err) });
        return;
      }
      var port = sw.port;
      var timer = setTimeout(function () {
        resolve({ sharedWorkerSupported: true, timeout: true });
      }, 20000);
      port.onmessage = function (e) {
        clearTimeout(timer);
        var data = { sharedWorkerSupported: true };
        Object.keys(e.data).forEach(function (k) {
          data[k] = e.data[k];
        });
        resolve(data);
      };
      sw.onerror = function (e) {
        clearTimeout(timer);
        resolve({ sharedWorkerSupported: true, sharedWorkerError: (e && e.message) || "error" });
      };
      port.start();
      port.postMessage({ cmd: command });
    });
  }

  // P4: worker A opens and HOLDS a sync access handle on a file; worker B then tries
  // to acquire a sync access handle on the same file and records the thrown error.
  function runP4() {
    var file = "p4-contended.bin";
    var workerA = new Worker("./dedicated.worker.js");
    return new Promise(function (resolve) {
      var holdTimer = setTimeout(function () {
        workerA.terminate();
        resolve({ error: "worker A never reported holding" });
      }, 20000);
      workerA.onmessage = function (e) {
        if (!e.data || !e.data.holding) {
          return;
        }
        clearTimeout(holdTimer);
        if (e.data.holdError) {
          workerA.terminate();
          resolve({ holdFailed: true, holdError: e.data.holdError });
          return;
        }
        // A is holding; now contend from worker B.
        var workerB = new Worker("./dedicated.worker.js");
        var contendTimer = setTimeout(function () {
          workerB.terminate();
          finishP4({ timeout: true });
        }, 20000);
        workerB.onmessage = function (be) {
          clearTimeout(contendTimer);
          workerB.terminate();
          finishP4(be.data);
        };
        workerB.onerror = function () {
          clearTimeout(contendTimer);
          workerB.terminate();
          finishP4({ workerError: true });
        };
        workerB.postMessage({ cmd: "contend", file: file });

        function finishP4(contendResult) {
          // Release A regardless, then resolve.
          var releaseTimer = setTimeout(function () {
            workerA.terminate();
            resolve(contendResult);
          }, 5000);
          workerA.onmessage = function (re) {
            if (re.data && re.data.released) {
              clearTimeout(releaseTimer);
              workerA.terminate();
              resolve(contendResult);
            }
          };
          workerA.postMessage({ cmd: "release" });
        }
      };
      workerA.onerror = function (e) {
        clearTimeout(holdTimer);
        workerA.terminate();
        resolve({ workerError: (e && e.message) || "worker A error" });
      };
      workerA.postMessage({ cmd: "hold", file: file });
    });
  }

  // P5: one dedicated worker loops creating distinct files and holding their sync
  // access handles open. Each acquisition is guarded by a watchdog inside the worker.
  function runP5Suite() {
    results.p5 = { classification: "incomplete", lastProgress: 0 };
    window.__PROBE_P5_PARTIAL__ = results.p5;
    return new Promise(function (resolve) {
      var w = new Worker("./dedicated.worker.js");
      var lastProgress = 0;
      var outer = setTimeout(function () {
        // No final classification and no watchdog fired at the worker level: the
        // renderer/worker is genuinely wedged. Do NOT terminate (it may be stuck).
        results.p5 = { classification: "wedged-no-final", lastProgress: lastProgress };
        window.__PROBE_P5_PARTIAL__ = results.p5;
        resolve();
      }, 150000);
      w.onmessage = function (e) {
        var d = e.data;
        if (d && d.p5progress !== undefined) {
          lastProgress = d.p5progress;
          results.p5 = { classification: "incomplete", lastProgress: lastProgress };
          window.__PROBE_P5_PARTIAL__ = results.p5;
          return;
        }
        if (d && d.p5) {
          clearTimeout(outer);
          results.p5 = d.p5;
          window.__PROBE_P5_PARTIAL__ = results.p5;
          w.terminate();
          resolve();
          return;
        }
        if (d && d.fatal) {
          clearTimeout(outer);
          results.p5 = { classification: "error", error: d.fatal, lastProgress: lastProgress };
          window.__PROBE_P5_PARTIAL__ = results.p5;
          w.terminate();
          resolve();
        }
      };
      w.onerror = function (e) {
        clearTimeout(outer);
        results.p5 = { classification: "worker-error", error: (e && e.message) || "error", lastProgress: lastProgress };
        window.__PROBE_P5_PARTIAL__ = results.p5;
        w.terminate();
        resolve();
      };
      w.postMessage({ cmd: "p5", count: 1200, watchdogMs: 5000 });
    });
  }

  async function main() {
    var mode = new URLSearchParams(location.search).get("mode") || "core";
    results.mode = mode;
    results.userAgent = navigator.userAgent;
    results.opfsSupported = opfsSupported();
    results.createSyncAccessHandleOnMainThread = methodPresent();
    try {
      await resetOpfs();
      if (mode === "p5") {
        await runP5Suite();
      } else {
        results.p1 = await askDedicated("p1", {});
        results.p2 = await askShared("p2");
        results.p3 = await askShared("p3");
        results.p4 = await runP4();
      }
    } catch (err) {
      results.fatal = describeError(err);
    } finally {
      finish();
    }
  }

  void main();
})();
