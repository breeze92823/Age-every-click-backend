// IslandRoom.ts's refreshLeaderboard(): how often it re-queries Mongo for the
// all-time top players per stat, and how many rows it fetches per stat before
// merging with the live online roster.
export const LEADERBOARD_REFRESH_MS = 15_000;
export const LEADERBOARD_QUERY_LIMIT = 20;
