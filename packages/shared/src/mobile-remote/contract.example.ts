/**
 * mobile-remote-link 标准用法：手机作 initiator、桌面网关作 responder，握手后互发 RPC。
 */
import { MobileRemoteInitiatorHandshake, MobileRemoteResponderHandshake } from "./channel.js";
import type { MobileRemoteStatus } from "./contract.js";
import { generateNoiseKeyPair } from "./noise.js";

export const mobileRemoteStatusExample = {
  enabled: true,
  relayUrl: "https://relay.example.com",
  hasRelayToken: true,
  hostId: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  hostName: "My Mac",
  relay: "online",
  devices: [{ id: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", name: "iPhone", pairedAt: 0, connected: true }],
} satisfies MobileRemoteStatus;

export function exampleMobileRemoteHandshake(): Uint8Array[] {
  const host = generateNoiseKeyPair();
  const toPhone: Uint8Array[] = [];
  const toHost: Uint8Array[] = [];
  const responder = new MobileRemoteResponderHandshake({ staticKey: host, write: (d) => toPhone.push(d) });
  const initiator = new MobileRemoteInitiatorHandshake({
    staticKey: generateNoiseKeyPair(),
    expectedHostKey: host.publicKey,
    hello: { type: "hello", protocolVersion: 1, deviceName: "iPhone" },
    write: (d) => toHost.push(d),
  });
  const { message, channel } = initiator.finish(responder.respond(initiator.start()));
  const accepted = responder.finish(message);
  accepted.channel.setHandlers({ onRpc: () => {}, onControl: () => {} });
  channel.sendRpc(new Uint8Array([1, 2, 3]));
  return toHost;
}
