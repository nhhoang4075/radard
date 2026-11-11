/** Advisory lock: creating, linking and changing owners run sequentially, so two concurrent sign-ins cannot link the same profile twice. */
export const PROFILE_LOCK_KEY = 7_302_419;
