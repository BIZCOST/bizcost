import type { DocumentPdfDto } from '@bizcost/contracts'

// A document's PDF in the browser (M3 Step 7; Q23): the API returns it in base64 (quotation.pdf, made
// on request and never stored); here it becomes a file to download, to hand to the phone's share sheet
// (WhatsApp, mail apps) or to open in the browser's own viewer.

/** The PDF as a file named as the API names it ("Q-0007.pdf"). */
export function pdfFileOf(pdf: DocumentPdfDto): File {
  const binary = atob(pdf.base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new File([bytes], pdf.fileName, { type: 'application/pdf' })
}

/** Saves the file through the browser's download (a link clicked for the person). */
export function downloadFile(file: File): void {
  const url = URL.createObjectURL(file)
  const link = document.createElement('a')
  link.href = url
  link.download = file.name
  link.rel = 'noopener'
  document.body.append(link)
  link.click()
  link.remove()
  // The download has started; the URL is freed a little later (some browsers read it after click).
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** Whether this browser can hand the file to the phone's share sheet. */
export function canShareFile(file: File): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.share === 'function' &&
    typeof navigator.canShare === 'function' &&
    navigator.canShare({ files: [file] })
  )
}

/**
 * Opens the share sheet with the file (call it straight from a tap: browsers allow it only then).
 * False when the person closed the sheet without sharing.
 */
export async function shareFile(file: File, title: string): Promise<boolean> {
  try {
    await navigator.share({ files: [file], title })
    return true
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return false
    throw error
  }
}
