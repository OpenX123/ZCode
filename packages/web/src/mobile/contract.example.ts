import type { PairedHost } from "./contract.js";

export const pairedHostExample = {
  hostId: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  hostName: "My Mac",
  relayUrl: "https://relay.example.com",
  pairedAt: 0,
  lastWindowId: 1,
} satisfies PairedHost;
