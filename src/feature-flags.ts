/**
 * Feature flags for controlling feature visibility at launch.
 *
 * TASKS_ENABLED: When false, task-related UI is hidden (settings toggle,
 * regen modal toggle). Tasks are still extracted by the AI and stored in
 * note metadata — this only controls visibility. Flip to true when ready
 * to launch the Tasks feature publicly.
 *
 * TRANSCRIPT_EDITING: When false, hides the "Edit transcript" command and
 * context menu item. The editing modal code stays but is unreachable.
 *
 * SPEAKER_NAMING: When false, hides the "Name speakers" command and
 * context menu item. Speaker diarization from Deepgram still runs.
 */
export const TASKS_ENABLED = false
export const TRANSCRIPT_EDITING = false
export const SPEAKER_NAMING = false
