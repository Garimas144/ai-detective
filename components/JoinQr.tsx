"use client";

import QRCode from "qrcode";
import { useEffect, useState } from "react";

export function JoinQr({ url }: { url: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    QRCode.toDataURL(url, { margin: 1, width: 400 }).then(setSrc).catch(() => setSrc(null));
  }, [url]);
  return src ? <img className="qr" src={src} alt={`QR code for ${url}`} /> : <div className="qr" />;
}
