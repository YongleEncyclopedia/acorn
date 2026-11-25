import { createStore } from "./store.ts";

/**
 * Whether the server is answering. The service worker marks what it answers from this device with an
 * `x-acorn-cached` header (web/public/sw.js); a request that gets no answer at all counts as offline too.
 */
export const connection = createStore({ offline: false });

/** Every API answer passes through here (lib/api.ts). */
export function noteAnswer(fromDevice: boolean): void {
  if (connection.get().offline === fromDevice) return;
  connection.set({ offline: fromDevice });
  // back online: changes made meanwhile can be sent (lib/outbox.ts)
  if (!fromDevice) window.dispatchEvent(new Event("acorn:reachable"));
}
