/**
 * Product switches for Belrog's local-first build.
 *
 * Belrog runs generation on the creator's own machine or on a server they own.
 * The upstream desktop build ships cloud account chrome - a credit balance, a
 * hosted "Belrog account" sheet, and a provider-status banner. None of it points
 * at anything Belrog serves, so it stays out of the UI until there is a Belrog
 * service behind it. Flip one flag here instead of deleting the components: the
 * components and their tests stay in the tree for the day something real is
 * wired to them.
 */

/** Show the hosted credit balance chip. No Belrog service backs it yet. */
export const SHOW_CREDITS_CHIP = false

/** Show the hosted account sheet (sign-in, allowance, computer sharing). */
export const SHOW_CLOUD_ACCOUNT_CHROME = false

/** Show the upstream engine/provider metering banner across the top of the app. */
export const SHOW_ENGINE_STATUS_BANNER = false
