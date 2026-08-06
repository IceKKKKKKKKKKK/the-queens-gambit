import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const games = sqliteTable(
  "games",
  {
    code: text("code").primaryKey(),
    blackTokenHash: text("black_token_hash").notNull(),
    whiteTokenHash: text("white_token_hash").notNull(),
    whiteInviteHash: text("white_invite_hash").notNull(),
    stateJson: text("state_json").notNull(),
    version: integer("version").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [index("games_expires_at_idx").on(table.expiresAt)],
);

export const roomCreationLimits = sqliteTable("room_creation_limits", {
  keyHash: text("key_hash").primaryKey(),
  windowStart: integer("window_start").notNull(),
  count: integer("count").notNull().default(0),
});
