import type { Store } from "./types";

/** Room actions wait for the socket and for the rejoin a dropped socket
 * needs: one sent before the room is rejoined is refused or lost. */
export const roomOffline = ({
  connectionStatus,
  rejoining,
}: Partial<Pick<Store, "connectionStatus" | "rejoining">>): boolean =>
  connectionStatus !== "connected" || rejoining === true;
