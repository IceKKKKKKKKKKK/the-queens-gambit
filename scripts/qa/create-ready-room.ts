import { randomBytes } from "node:crypto";

import type { AugmentId } from "../../lib/augments.ts";
import type { PlayerAction, ProjectedGame, Side } from "../../lib/game.ts";

interface RoomEnvelope {
  code: string;
  version: number;
  viewer: Side | "spectator";
  snapshot: ProjectedGame;
}

interface CreatedRoom extends RoomEnvelope {
  opponentInviteToken: string;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${url}: ${text}`);
  return JSON.parse(text) as T;
}

const originFor = (side: Side) => `http://localhost:${side === "black" ? 4318 : 4319}`;

async function getRoom(code: string, side: Side) {
  return json<RoomEnvelope>(`${originFor(side)}/api/rooms/${code}`);
}

async function act(code: string, side: Side, action: PlayerAction) {
  const current = await getRoom(code, side);
  return json<RoomEnvelope>(`${originFor(side)}/api/rooms/${code}/actions`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: originFor(side) },
    body: JSON.stringify({ expectedVersion: current.version, action }),
  });
}

async function selectFirstAndLock(code: string, side: Side) {
  const current = await getRoom(code, side);
  const round = current.snapshot.augment?.draft.rounds.find(
    (candidate) => candidate.number === current.snapshot.augment?.draft.activeRound,
  );
  const augmentId = round?.players[side].options?.[0] as AugmentId | undefined;
  if (!augmentId) throw new Error(`No draft option for ${side}.`);
  await act(code, side, { type: "augment_select", augmentId });
  await act(code, side, { type: "augment_lock" });
}

async function run() {
  const blackOrigin = originFor("black");
  const created = await json<CreatedRoom>(`${blackOrigin}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: blackOrigin },
    body: JSON.stringify({ gameMode: "augment", spectatorPolicy: "hidden" }),
  });
  const whiteOrigin = originFor("white");
  await json<RoomEnvelope>(`${whiteOrigin}/api/rooms/${created.code}/claim`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: whiteOrigin },
    body: JSON.stringify({
      inviteToken: created.opponentInviteToken,
      playerToken: randomBytes(24).toString("base64url"),
    }),
  });
  await selectFirstAndLock(created.code, "black");
  await selectFirstAndLock(created.code, "white");
  await act(created.code, "black", { type: "randomize" });
  await act(created.code, "white", { type: "randomize" });
  await act(created.code, "black", { type: "ready", value: true });
  const ready = await act(created.code, "white", { type: "ready", value: true });
  if (ready.snapshot.phase !== "playing") throw new Error("Room did not enter playing phase.");
  console.log(JSON.stringify({ code: created.code, turn: ready.snapshot.turn }));
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
