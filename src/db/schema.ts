import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
});

// Update watchlist to reference the integer ID
export const watchlist = sqliteTable("watchlist", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(), // Links to users.id
  mediaId: text("media_id").notNull(),
  type: text("type").notNull(),
  score: integer("score"),
  status: text("status"),
  // Nullable + no DB-level default: Turso/libsql rejects ALTER TABLE ADD COLUMN
  // with a non-constant default (e.g. unixepoch()). Set explicitly on insert instead.
  createdAt: integer("created_at", { mode: "timestamp" }),
}, (table) => [
  // The app reads a user's list on nearly every page, and enforces "one row per
  // title per user" with a select-then-insert. The unique index closes the race
  // between those two statements and makes the lookup an index hit.
  uniqueIndex("watchlist_user_media_idx").on(table.userId, table.mediaId),
  index("watchlist_user_idx").on(table.userId),
]);