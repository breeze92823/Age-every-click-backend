// IslandRoom.ts's refreshLeaderboard(): how often it re-queries Mongo for the
// all-time top players per stat, and how many rows it fetches per stat before
// merging with the live online roster.
export const LEADERBOARD_REFRESH_MS = 15_000;
export const LEADERBOARD_QUERY_LIMIT = 20;

// Lucky Wheel's free spin (client components/hud/LuckyWheel.jsx): one claim per
// account per this window, timed by the SERVER clock (IslandRoom.ts's
// `claimFreeSpin`) so changing the device clock can't skip the wait.
export const FREE_SPIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const SPINS_MAX = 9999;

// Impossible Bridge shared puzzle (rooms/IslandRoom.ts, client
// data/bonusBridge.js / systems/bonusBridge.js). BRIDGE_COLUMNS/BRIDGE_LANES
// mirror the client's own COLUMNS/LANE_X.length, and
// BRIDGE_UNSAFE_RESET_DELAY_MS mirrors UNSAFE_RESET_DELAY (1.3s) -- kept in
// sync by comment cross-reference, not a shared import, same convention as
// IslandRoom.ts's tutorial-step mirror.
export const BRIDGE_COLUMNS = 6;
export const BRIDGE_LANES = 2;
export const BRIDGE_UNSAFE_RESET_DELAY_MS = 1300;
// After this many total falls/timeouts across the whole group (client
// systems/bonusBridge.js's respawnAtStart(), relayed as `bridgeFail`), the
// room rerolls a brand new shared layout for everyone -- including anyone
// still mid-attempt -- so the puzzle doesn't stay solved forever once the
// group has learned it. Not per-player: one unlucky player repeatedly
// falling reshuffles it for the whole room just as much as five different
// players each failing once.
export const BRIDGE_RESHUFFLE_AFTER_FAILS = 5;
