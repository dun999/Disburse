import QRCode from "qrcode";

export async function buildQrDataUrl(value: string): Promise<string> {
  if (!value.trim()) {
    throw new Error("QR code value is empty.");
  }

  return QRCode.toDataURL(value, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 320,
    color: {
      dark: "#20211d",
      light: "#fffefa"
    }
  });
}
