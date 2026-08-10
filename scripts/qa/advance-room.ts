import { getProjectedLegalTargets, isInsideBoard, type ProjectedGame, type Side } from "../../lib/game.ts";

interface RoomEnvelope {
  version: number;
  viewer: Side | "spectator";
  snapshot: ProjectedGame;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${url}: ${text}`);
  return JSON.parse(text) as T;
}

async function run() {
  const code = process.argv[2]?.replaceAll("-", "").toUpperCase();
  const requestedMoves = Number(process.argv[3] ?? 9);
  if (!code || !Number.isSafeInteger(requestedMoves) || requestedMoves < 1) {
    throw new Error("Usage: advance-room.ts <room-code> [move-count]");
  }
  let completed = 0;
  while (completed < requestedMoves) {
    const probe = await json<RoomEnvelope>(`http://localhost:4318/api/rooms/${code}`);
    if (probe.snapshot.phase !== "playing") break;
    const side = probe.snapshot.turn;
    const origin = `http://localhost:${side === "black" ? 4318 : 4319}`;
    const room = side === "black"
      ? probe
      : await json<RoomEnvelope>(`${origin}/api/rooms/${code}`);
    if (room.viewer !== side) throw new Error(`Expected ${side} viewer, received ${room.viewer}.`);
    let action: { type: "move"; from: { row: number; col: number }; to: { row: number; col: number } } | null = null;
    for (const piece of room.snapshot.pieces) {
      if (!piece.alive || piece.side !== side || !isInsideBoard(piece)) continue;
      const targets = getProjectedLegalTargets(room.snapshot, side, piece);
      const target = targets[0];
      if (!target) continue;
      action = {
        type: "move",
        from: { row: piece.row, col: piece.col },
        to: target,
      };
      break;
    }
    if (!action) throw new Error(`No projected legal move for ${side} at move ${room.snapshot.moveNumber}.`);
    const next = await json<RoomEnvelope>(`${origin}/api/rooms/${code}/actions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
      },
      body: JSON.stringify({ expectedVersion: room.version, action }),
    });
    completed += 1;
    console.log(`move=${next.snapshot.moveNumber} phase=${next.snapshot.phase} next=${next.snapshot.turn}`);
    if (next.snapshot.phase !== "playing") break;
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
