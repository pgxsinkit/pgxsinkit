export const PERF_LAB_COMPOSE_PROJECT = "pgxsinkit-perf-lab";
export const PERF_LAB_HOST = "127.0.0.1";
export const PERF_LAB_POSTGRES_PORT = 54421;
export const PERF_LAB_DURABLE_STREAMS_PORT = 3100;
export const PERF_LAB_CIRCUITS_ENGINE_PORT = 3102;
export const PERF_LAB_WRITE_API_PORT = 3101;
export const PERF_LAB_VITE_PORT = 5174;
export const PERF_LAB_LOG_DIR = "tmp/perf-lab";

export const PERF_LAB_DATABASE_URL = `postgresql://postgres:password@${PERF_LAB_HOST}:${PERF_LAB_POSTGRES_PORT}/pgxsinkit?sslmode=disable`;
export const PERF_LAB_DURABLE_STREAMS_URL = `http://${PERF_LAB_HOST}:${PERF_LAB_DURABLE_STREAMS_PORT}`;
export const PERF_LAB_CIRCUITS_ENGINE_URL = `http://${PERF_LAB_HOST}:${PERF_LAB_CIRCUITS_ENGINE_PORT}`;
export const PERF_LAB_WRITE_API_URL = `http://${PERF_LAB_HOST}:${PERF_LAB_WRITE_API_PORT}`;

// The perf-lab server hosts the control plane and the edge alongside the write route, so all three
// share one origin. Production separates the edge — it is the CDN-frontable surface — but the lab is
// measuring the client, not the topology.
export const PERF_LAB_CONTROL_PLANE_URL = PERF_LAB_WRITE_API_URL;
export const PERF_LAB_STREAM_MOUNT_PATH = "/v1/stream";
export const PERF_LAB_STREAM_BASE_URL = `${PERF_LAB_WRITE_API_URL}${PERF_LAB_STREAM_MOUNT_PATH}`;
