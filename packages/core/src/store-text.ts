import { wellFormed } from '@bulig/text';

/**
 * Rules about text that every adapter applies before a value reaches its engine, so both engines accept and refuse the same things.
 *
 * - JSON values (state, event payloads, stage output): a lone UTF-16 surrogate (half an emoji) or a NUL character inside a
 *   string becomes U+FFFD, through `storableJson` in @bulig/text. A stray half-character must not cost a whole write, and
 *   the two engines must store the same thing.
 * - Plain text columns and identifiers (repo, title, body, ids, names, keys, statuses, event types, sources): a NUL
 *   character is refused with a clear error, and a lone surrogate becomes U+FFFD (SQLite would keep it as three replacement
 *   characters and Postgres as one, so the text is made well formed first). Postgres cannot store it in TEXT, and SQLite would store it and then treat the
 *   text as ending there in places. These are names and keys, so quietly changing one would let two different names
 *   collide. Refusing is the safe answer, and it happens before the database, so a Postgres transaction is not abandoned
 *   by a server error halfway through.
 * - JSON object key order: Postgres JSONB does not keep the order keys were written in, SQLite does. No caller depends on
 *   the order of keys.
 */
export function text<T extends string>(what: string, value: T): T {
  if (value.includes('\u0000')) throw new Error(`${what} contains a NUL character, which the store does not accept`);
  return wellFormed(value) as T;
}
