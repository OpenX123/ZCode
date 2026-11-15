import { createContext, useContext, useSyncExternalStore } from "react";
import type { ConversationDisclosureScope, DisclosureState } from "./contract.js";

const overrides = new Map<string, { open: boolean; order: number }>();
const listeners = new Set<() => void>();
let version = 0;
export const useConversationDisclosureScope = () => useContext(DisclosureScope);
const DisclosureScope = createContext<ConversationDisclosureScope | undefined>(undefined);
export const ConversationDisclosureProvider = DisclosureScope.Provider;
export function getConversationDisclosureOverride(keys: readonly string[]): boolean | undefined {
  let latest: { open: boolean; order: number } | undefined;
  for (const key of keys) {
    const entry = overrides.get(key);
    if (entry && (!latest || entry.order > latest.order)) latest = entry;
  }
  return latest?.open;
}
export function setConversationDisclosureOverride(keys: readonly string[], open: boolean): void {
  version += 1;
  for (const key of keys) overrides.set(key, { open, order: version });
  for (const listener of listeners) listener();
}
export function subscribeConversationDisclosure(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export const getConversationDisclosureVersion = () => version;
const noSubscription = (_listener: () => void) => () => {};
export function useConversationDisclosureVersion(enabled = true): number {
  return useSyncExternalStore(
    enabled ? subscribeConversationDisclosure : noSubscription,
    getConversationDisclosureVersion,
    getConversationDisclosureVersion,
  );
}
export const visibleDisclosureOpen = (state: DisclosureState): boolean =>
  state.userOverride ?? state.defaultOpen;
