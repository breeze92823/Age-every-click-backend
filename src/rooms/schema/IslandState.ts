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
  },
  "PlayerState",
);
export type PlayerState = SchemaType<typeof PlayerState>;

export const IslandState = schema(
  {
    players: t.map(PlayerState), // keyed by sessionId
  },
  "IslandState",
);
export type IslandState = SchemaType<typeof IslandState>;
