import * as SqlClient from "effect/unstable_sql/SqlClient";
import * as Effect from "effect/Effect";
import { SqlError } from "effect/unstable_sql/SqlError";

const LOCAL_EXECUTION_TARGET_JSON = '{"kind":"local"}';

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
    ALTER TABLE projection_projects
    ADD COLUMN execution_target_json TEXT
  `.pipe(
    Effect.catch((error) => (isDuplicateColumnError(error) ? Effect.void() : Effect.fail(error))),
  );

  yield* sql`
    UPDATE projection_projects
    SET execution_target_json = ${LOCAL_EXECUTION_TARGET_JSON}
    WHERE execution_target_json IS NULL
  `;

  yield* sql`
    ALTER TABLE provider_session_runtime
    ADD COLUMN execution_target_json TEXT
  `.pipe(
    Effect.catch((error) => (isDuplicateColumnError(error) ? Effect.void() : Effect.fail(error))),
  );

  yield* sql`
    UPDATE provider_session_runtime
    SET execution_target_json = ${LOCAL_EXECUTION_TARGET_JSON}
    WHERE execution_target_json IS NULL
  `;
});
