import { startCaptureFromPage } from "./capture";
import { startResolve } from "./resolve";

/**
 * The oddsjam.com content script: passive capture always, plus finishing a deep link when the tab
 * was opened carrying one.
 *
 * Both halves run on every matching page, and the order is deliberate -- capture first, so a slate
 * the resolver is about to walk (or a game page it is about to read a market id out of) is recorded
 * for the cache whether or not the resolve then succeeds. A tab opened without a request in its
 * fragment gets capture alone, exactly as before this feature grew a second half.
 */
startCaptureFromPage();
startResolve();
