export const PERF_LAB_COMPOSE_PROJECT = "pgxsinkit-perf-lab";
export const PERF_LAB_HOST = "127.0.0.1";
export const PERF_LAB_POSTGRES_PORT = 54421;
export const PERF_LAB_ELECTRIC_PORT = 3100;
export const PERF_LAB_WRITE_API_PORT = 3101;
export const PERF_LAB_VITE_PORT = 5174;
export const PERF_LAB_LOG_DIR = "tmp/perf-lab";

export const PERF_LAB_DATABASE_URL = `postgresql://postgres:password@${PERF_LAB_HOST}:${PERF_LAB_POSTGRES_PORT}/pgxsinkit?sslmode=disable`;
export const PERF_LAB_ELECTRIC_URL = `http://${PERF_LAB_HOST}:${PERF_LAB_ELECTRIC_PORT}/v1/shape`;
export const PERF_LAB_WRITE_API_URL = `http://${PERF_LAB_HOST}:${PERF_LAB_WRITE_API_PORT}`;
export const PERF_LAB_SHAPE_PROXY_URL = `${PERF_LAB_WRITE_API_URL}/v1/shape-proxy`;
