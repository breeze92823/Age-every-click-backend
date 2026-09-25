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
