/**
 * Matching lives in @clv/shared so the extension and the server compute identical keys -- the
 * board asks "is this row already tracked?" using exactly the key the server stored.
 */
export {
  normalizeName,
  stripTrailingLine,
  findMatchingRow,
  buildMatchKey,
  matchKeyForRow,
  type MatchTarget,
} from "@clv/shared";
