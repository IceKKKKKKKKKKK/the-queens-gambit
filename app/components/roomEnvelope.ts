type RoomTransportCredentials = {
  playerToken?: string;
  opponentInviteToken?: string;
};

/**
 * Keep every room projection field returned by the server while ensuring
 * transport-only credentials do not become part of the rendered room state.
 */
export function roomEnvelopeFromTransport<T extends RoomTransportCredentials>(
  response: T,
): Omit<T, keyof RoomTransportCredentials> {
  const room = { ...response };
  delete room.playerToken;
  delete room.opponentInviteToken;
  return room;
}
