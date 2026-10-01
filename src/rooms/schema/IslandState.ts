import { schema, t, type SchemaType } from "@colyseus/schema";

export const PlayerState = schema(
  {
    username: t.string().default(""), // client-reported Bloxity displayName/username, not validated
    x: t.number().default(0),
    y: t.number().default(0),
    z: t.number().default(0),
    yaw: t.number().default(0),
    // 0..1 eased gait factor (client systems/avatarAnim.js, systems/net.js
    // reportLocal()) -- purely cosmetic, drives remote walk-cycle blend.
    moveBlend: t.number().default(0),
    // The player's Bloxity avatar (equipped cosmetics + proportions) as a JSON
    // string, same shape client systems/avatarLoader.js's assembleAvatar()
    // consumes: {"e": <equipped ids object>, "p": <proportions object>}.
    // Client-reported, never validated -- only length-capped (see
    // IslandRoom.ts AVATAR_MAX_LEN). Opaque to the server: stored and relayed
    // as-is, never parsed here.
    avatar: t.string().default(""),
    // Live client-reported gameplay stats (client store/useGameStore.js
    // speed/coins/rebirth), so an in-world leaderboard can rank currently-
    // connected players. Client-reported, never validated beyond a
    // finite/non-negative check (IslandRoom.ts's `stats` handler) -- same
    // trust model as `username`/`avatar`. No persistence: like every other
    // field here, these reset to 0 for a player on rejoin and the whole room
    // resets on server restart -- durable state lives in Mongo (src/db.ts),
    // not here.
    speed: t.number().default(0), // "Age" -- see data/progression.js
    coins: t.number().default(0),
    rebirth: t.number().default(0),
    // Which scene/instance this connection is currently in (client
    // store/useGameStore.js's currentScene, e.g. "island" or "bonus") --
    // client-reported, same trust model as username/avatar. Lets every other
    // client's components/RemotePlayers.jsx only render a session alongside
    // players who are actually sharing the same scene right now, instead of
    // an island player appearing to stand on the (separately located)
    // Impossible Bridge, or vice versa.
    scene: t.string().default("island"),
  },
  "PlayerState",
);
export type PlayerState = SchemaType<typeof PlayerState>;

// One tile of the Impossible Bridge glass-bridge obby (client
// data/bonusBridge.js / systems/bonusBridge.js). The room owns this for its
// whole lifetime -- see IslandState.bridgeTiles' own comment for why.
export const BridgeTileState = schema(
  {
    // Whether this lane is the safe one for its column. Set once, when the
    // room builds the shared layout (IslandRoom.ts's buildBridgeLayout()),
    // and never changes afterwards -- every connected player solves the
    // same puzzle, not a personally-randomized one.
    safe: t.boolean().default(false),
    // True while sprung: a player's foot proved this lane unsafe. Collision
    // is off (client systems/bonusBridge.js's supports()) for EVERY player
    // standing near it while this is true -- a shared hazard, not a
    // personal one. IslandRoom.ts flips it back to false on its own
    // re-arm timer (BRIDGE_UNSAFE_RESET_DELAY_MS).
    broken: t.boolean().default(false),
    // One-shot and never reset: once any player proves a glass tile safe it
    // stays revealed (green) for the whole room for good -- the shared
    // puzzle only ever gets easier as the group learns it, it never
    // re-randomizes under a player who's already mid-attempt.
    bounced: t.boolean().default(false),
  },
  "BridgeTileState",
);
export type BridgeTileState = SchemaType<typeof BridgeTileState>;

export const IslandState = schema(
  {
    players: t.map(PlayerState), // keyed by sessionId
    // The Impossible Bridge's one shared tile layout/state, built once at
    // room startup (IslandRoom.ts onCreate) and kept for the room's whole
    // lifetime -- see BridgeTileState's own comment. Index i here is always
    // the same physical tile as client systems/bonusBridge.js's `tiles[i]`
    // (both built in identical column-major order -- see
    // IslandRoom.ts's buildBridgeLayout()).
    bridgeTiles: t.array(BridgeTileState),
  },
  "IslandState",
);
export type IslandState = SchemaType<typeof IslandState>;
