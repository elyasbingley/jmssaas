// Browser equivalent of apps/mobile/lib/print.ts's expo-print +
// expo-sharing pipeline - there's no on-device PDF renderer or native share
// sheet here, so this opens the HTML in a new tab and triggers the
// browser's own print dialog, which every major browser can "Save as PDF"
// from directly. No backend call, same as mobile's on-device approach.
export function exportPdf(html: string, title: string): void {
  const win = window.open("", "_blank");
  if (!win) {
    throw new Error("Pop-up blocked - allow pop-ups for this site to export a PDF");
  }
  win.document.write(html);
  win.document.title = title;
  win.document.close();
  win.focus();
  win.print();
}
