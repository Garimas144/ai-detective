// Browser microphone diagnostics. Turns cryptic failures into instructions a player can act on.
// Phones need a secure context (HTTPS, or localhost) before the browser will offer the microphone at all.

export type MicSupport = { ok: true } | { ok: false; reason: "insecure" | "unsupported"; message: string };

export function micSupport(): MicSupport {
  if (typeof window === "undefined") return { ok: true };
  if (!window.isSecureContext) {
    return {
      ok: false,
      reason: "insecure",
      message: `The microphone only works on a secure (https) page, and this page is ${window.location.protocol}//${window.location.host}. Ask the host to share the https tunnel link, then rejoin.`,
    };
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return {
      ok: false,
      reason: "unsupported",
      message: "This browser can't use the microphone. If you opened the link inside another app (Instagram, Messenger, a QR scanner), open it in Safari or Chrome instead.",
    };
  }
  return { ok: true };
}

const isIOS = () => typeof navigator !== "undefined" && /iPhone|iPad|iPod/i.test(navigator.userAgent);

/** Explains a getUserMedia / SDK error. Pass anything: an Error, a string, or a DOMException name. */
export function explainMicError(err: unknown): string {
  const text = err instanceof Error ? `${err.name} ${err.message}` : String(err ?? "");
  if (/NotAllowed|Permission|denied|dismissed/i.test(text)) {
    return isIOS()
      ? "Microphone access is blocked. On iPhone: tap the aA icon in the address bar, choose Website Settings, set Microphone to Allow, then reload. (Also check Settings > Safari > Microphone.)"
      : "Microphone access is blocked. Tap the lock icon in the address bar, allow the Microphone, then reload the page.";
  }
  if (/NotFound|DevicesNotFound|no.*(device|microphone)/i.test(text)) return "No microphone was found on this device.";
  if (/NotReadable|TrackStart|in use/i.test(text)) return "The microphone is busy in another app. Close it and try again.";
  return "";
}
