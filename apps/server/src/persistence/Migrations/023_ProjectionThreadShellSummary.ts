import * as SqlClient from "effect/unstable_sql/SqlClient";
import * as Effect from "effect/Effect";
import { SqlError } from "effect/unstable_sql/SqlError";

const isDuplicateColumnError = (error: unknown): boolean => {
  if (error instanceof SqlError) {
    const message = error.message.toLowerCase();
    return message.includes("duplicate column");
  }
  return false;
};

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN latest_user_message_at TEXT
  `.pipe(
    Effect.catch((error) => (isDuplicateColumnError(error) ? Effect.void() : Effect.fail(error))),
  );

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN pending_approval_count INTEGER NOT NULL DEFAULT 0
  `.pipe(
    Effect.catch((error) => (isDuplicateColumnError(error) ? Effect.void() : Effect.fail(error))),
  );

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN pending_user_input_count INTEGER NOT NULL DEFAULT 0
  `.pipe(
    Effect.catch((error) => (isDuplicateColumnError(error) ? Effect.void() : Effect.fail(error))),
  );

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN has_actionable_proposed_plan INTEGER NOT NULL DEFAULT 0
  `.pipe(
    Effect.catch((error) => (isDuplicateColumnError(error) ? Effect.void() : Effect.fail(error))),
  );
});
