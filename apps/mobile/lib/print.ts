import * as Print from "expo-print";
import * as Sharing from "expo-sharing";

// Renders an HTML document to a PDF file (expo-print's printToFileAsync,
// verified against the installed expo-print@57.0.1 types) and immediately
// opens the native share sheet for it. On-device generation was chosen over
// a server-side (Supabase Edge Function) approach - see docs/SETUP.md's
// Phase 5 known-gaps note for the full reasoning - so this needs no backend
// call, just the HTML string built in lib/pdf.ts.
export async function exportPdf(html: string, dialogTitle: string): Promise<void> {
  const { uri } = await Print.printToFileAsync({ html, base64: false });

  const canShare = await Sharing.isAvailableAsync();
  if (!canShare) {
    // No share sheet available (e.g. some Android configurations) - the
    // file still exists at `uri` in the app's cache directory, there's just
    // no platform-native way to hand it off from here.
    throw new Error("Sharing isn't available on this device");
  }

  await Sharing.shareAsync(uri, { mimeType: "application/pdf", UTI: "com.adobe.pdf", dialogTitle });
}

// Same on-device render as exportPdf, but returns the PDF as a base64
// data URI instead of opening the share sheet - for auto-attaching a
// quote/invoice PDF to an outgoing email (EmailComposeModal's
// defaultAttachments), where there's no human interaction to hand off to.
export async function buildPdfDataUri(html: string): Promise<string> {
  const { base64 } = await Print.printToFileAsync({ html, base64: true });
  if (!base64) throw new Error("Failed to generate PDF");
  return `data:application/pdf;base64,${base64}`;
}
