import type { FetchHandler } from "./handlers";

export interface BoardBackendFetchOptions {
  boardWrite: FetchHandler;
  boardSync: FetchHandler;
}

export function createBoardBackendFetch(options: BoardBackendFetchOptions): FetchHandler {
  return async (request) => {
    const { pathname } = new URL(request.url);

    if (pathname === "/board-write" || pathname.startsWith("/board-write/")) {
      return options.boardWrite(request);
    }

    if (pathname === "/board-sync" || pathname.startsWith("/board-sync/")) {
      return options.boardSync(request);
    }

    if (pathname === "/health" || pathname === "/_internal/health") {
      return Response.json({ ok: true });
    }

    return Response.json({ message: "Not found" }, { status: 404 });
  };
}
