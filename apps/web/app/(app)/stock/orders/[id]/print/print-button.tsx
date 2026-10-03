'use client';

/** Opens the phone's print dialog (print, or save as PDF to share). */
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="min-h-11 rounded-lg bg-brand-700 px-4 text-sm font-medium text-white"
    >
      Print or save as PDF
    </button>
  );
}
