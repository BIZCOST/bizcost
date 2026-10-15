// The downloadable templates (M3 Step 4): CSV files with a byte-order mark (so a spreadsheet opens
// Arabic headers right), their headers in the person's language. The importer knows both languages'
// headers (fieldsOfHeader in @bizcost/domain), so a template filled in either is read the same.

export const TEMPLATES = ['daily', 'lines', 'statement'] as const
export type TemplateKind = (typeof TEMPLATES)[number]

/** Each template's headers, in English and Arabic (one header a column, in the same order). */
export const TEMPLATE_HEADERS: Readonly<Record<TemplateKind, { en: string[]; ar: string[] }>> = {
  // Daily sales by product: one row a day and item.
  daily: {
    en: ['Date', 'Item', 'Item code', 'Quantity', 'Sales'],
    ar: ['التاريخ', 'الصنف', 'رمز الصنف', 'الكمية', 'المبيعات'],
  },
  // Sales lines: one row an order line, its order's day and number, and what the app kept.
  lines: {
    en: ['Date', 'Order number', 'Item', 'Item code', 'Quantity', 'Total', 'Commission'],
    ar: ['التاريخ', 'رقم الطلب', 'الصنف', 'رمز الصنف', 'الكمية', 'الإجمالي', 'العمولة'],
  },
  // A channel's statement: one row a statement.
  statement: {
    en: [
      'From',
      'To',
      'Sales',
      'Commission',
      'Payment fees',
      'Other fees',
      'Ads',
      'Refunds charged',
      'Payout',
    ],
    ar: [
      'من',
      'إلى',
      'المبيعات',
      'العمولة',
      'رسوم الدفع',
      'رسوم أخرى',
      'الإعلانات',
      'المبالغ المستردة المخصومة',
      'المبلغ المحوّل',
    ],
  },
}

const BOM = '\ufeff'

/** A cell as CSV writes it: quoted when it holds a comma, a quote or a line break. */
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

/** A template's text: the byte-order mark and its header row (CRLF, as spreadsheets write it). */
export function templateCsv(kind: TemplateKind, language: 'en' | 'ar'): string {
  return `${BOM}${TEMPLATE_HEADERS[kind][language].map(csvCell).join(',')}\r\n`
}

/** The file name a template downloads as. */
export function templateFileName(kind: TemplateKind, language: 'en' | 'ar'): string {
  const names: Record<TemplateKind, string> = {
    daily: 'daily-sales-by-product',
    lines: 'sales-lines',
    statement: 'channel-statement',
  }
  return `bizcost-${names[kind]}${language === 'ar' ? '-ar' : ''}.csv`
}

/** Starts a template's download (a Blob link; nothing is sent anywhere). */
export function downloadTemplate(kind: TemplateKind, language: 'en' | 'ar'): void {
  const blob = new Blob([templateCsv(kind, language)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = templateFileName(kind, language)
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
