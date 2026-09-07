/** Name of the HTTP-only session cookie holding the Auth access token. */
export const SESSION_COOKIE = 'screencast_session';

/** Short-lived cookie holding the CSRF state generated before redirect. */
export const STATE_COOKIE = 'screencast_auth_state';

/** Where to send the operator after sign-in; a same-site path, never a URL. */
export const NEXT_COOKIE = 'screencast_auth_next';
