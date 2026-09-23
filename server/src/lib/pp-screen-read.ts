/**
 * The server-side read of PropProfessor's odds screen -- permanently disabled.
 *
 * This used to POST directly to `backend.propprofessor.com` on the Odds modal's fast path. That
 * automation is what got the PropProfessor account banned (2026-09), so `readScreenNow` now throws
 * before it ever builds a request, let alone sends one. The function stays rather than being
 * deleted so the shape of what happened here is not lost, and so a future decision to read
 * PropProfessor again (if ever made, deliberately, by a human) has one obvious place to undo this.
 *
 * `odds-preview.ts` no longer calls this at all -- the Odds modal now answers exclusively from The
 * Odds API (`odds-api-read.ts`) -- so this throwing is belt-and-suspenders, not the only thing
 * standing between this app and PropProfessor's backend.
 */

export class PropProfessorDisabledError extends Error {
  constructor() {
    super(
      "PropProfessor reads are disabled: this account was banned for automated access and the " +
        "server must never contact backend.propprofessor.com again."
    );
    this.name = "PropProfessorDisabledError";
  }
}

export async function readScreenNow(): Promise<never> {
  throw new PropProfessorDisabledError();
}
