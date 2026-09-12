/**
 * Warms the PropProfessor session the moment the dashboard is opened.
 *
 * The Odds modal can only answer instantly if the server already holds a screen token, and the only
 * place that token can come from is this extension. Everything else that supplies it is on a timer:
 * browser startup, and the 60-second closing alarm. That leaves one visible gap -- the server is
 * restarted (it holds the token in memory by design), the user opens the dashboard, clicks Odds,
 * and waits out an alarm period for a read that takes a fraction of a second.
 *
 * So the dashboard itself says "I am here". This script does nothing else: no DOM, no page data, no
 * listeners. It is not in the manifest either, because the dashboard's origin is whatever the user
 * typed into the options page -- it is registered at runtime by `registerDashboardWarmer()` in the
 * service worker, against exactly that origin and no other.
 */

void chrome.runtime
  .sendMessage({ type: "clv:warm" })
  // The worker may be asleep and the message may be dropped on the way in; the alarm is the
  // backstop, and there is nothing useful to do about it here.
  .catch(() => undefined);
