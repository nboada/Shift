/** Running in the iOS app rather than on the Mac. */
export const IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
/** What the UI calls the machine Shift keeps mail on. */
export const DEVICE = IS_IOS ? "iPhone" : "Mac";
