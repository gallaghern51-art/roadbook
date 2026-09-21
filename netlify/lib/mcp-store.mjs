// Short-lived server memory for the MCP server: route-option sets a rider's
// own AI showed them, kept long enough for the rider to pick one and save it
// as a trip. Netlify Blobs in production (store "mcp-options"); a module Map
// under `vite dev` and in the check scripts, where Blobs has no site context —
// the same pattern job-store.mjs and collab.mjs use.
//
// Nothing here is a source of truth. A set that expires is a set the rider
// can measure again in one tool call; the trips they SAVE go to user_trips.

const TTL_MS = 24 * 3_600_000;

const devMem = new Map();
const memStore = {
  get: async (k) => {
    const v = devMem.get(k);
    return v == null ? null : JSON.parse(v);
  },
  setJSON: async (k, v) => { devMem.set(k, JSON.stringify(v)); },
  delete: async (k) => { devMem.delete(k); },
};

let blobsMod;
async function store() {
  if (blobsMod === undefined) {
    try { blobsMod = await import('@netlify/blobs'); } catch { blobsMod = null; }
  }
  if (blobsMod) {
    try {
      const s = blobsMod.getStore({ name: 'mcp-options', consistency: 'strong' });
      return {
        get: (k) => s.get(k, { type: 'json' }),
        setJSON: (k, v) => s.setJSON(k, v),
        delete: (k) => s.delete(k),
      };
    } catch { /* no Blobs env — dev */ }
  }
  return memStore;
}

const newId = () => `opt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Keep an option set for the rider who asked for it. Returns its id. */
export async function putOptionSet(userId, set) {
  const id = newId();
  const s = await store();
  await s.setJSON(id, { ...set, id, userId, createdAt: Date.now(), expiresAt: Date.now() + TTL_MS });
  return id;
}

/**
 * The set, if it is this rider's and still fresh. A set another account
 * measured is nobody else's to save — the check is by user id, not by
 * guessing the id, because ids are short and the sets are cheap.
 */
export async function getOptionSet(userId, id) {
  if (!id) return null;
  const s = await store();
  const set = await s.get(String(id)).catch(() => null);
  if (!set || set.userId !== userId) return null;
  if (set.expiresAt && set.expiresAt < Date.now()) { await s.delete(String(id)).catch(() => {}); return null; }
  return set;
}

/** Test seam. */
export function _resetMemStore() { devMem.clear(); }
