/** Rough time to read a question aloud. Shared so the server (answer clock) and the phone (when the mic unlocks) agree. */
export function readAloudMs(text: string): number {
  const words = text.trim().split(/\s+/).length;
  return Math.ceil((words / 2.6) * 1000) + 1500;
}
