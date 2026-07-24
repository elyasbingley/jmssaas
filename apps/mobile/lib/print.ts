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
