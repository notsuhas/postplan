/** Query param carrying the viewer's per-load secret into the content frame. */
export const FRAME_NONCE_PARAM = 'postplan_frame'
/** First message from a framed page: carries the nonce and hands the viewer a MessagePort. */
export const FRAME_HELLO = 'postplan:hello'
