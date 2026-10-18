// BizCost's document template (M3 Step 7; D-224, D-288–D-290; the owner's document requests of
// 2026-10-16, docs/mockups/documents-owner-reference.md): one frame for a quotation now and Step 8's
// tax invoice («فاتورة ضريبية · Tax Invoice»), invoice and credit notes. The letterhead on every page is
// drawn from each business's own names, logo, accent colour and contact lines, never a fixed artwork
// («بحسب اسم ومعلومات كل شركة»), in the language of the owner's Word letterhead («قريب هذا»): bold
// diagonal bars in the top corners joined by a thin rule, the logo centred with the English and Arabic
// names under it and the seller's TRN and trade licence under them, a large light watermark of the logo
// (a draft's mark takes its place), the contact lines with icons in a rounded bracket on the start side
// with the document's number and page on the end side, and bold bars in the bottom end corner.
//
// Everything printed comes from /data.json (a DocumentPdfInput built by the server, input.ts) and the
// images the server mapped under /img/. Text from people is only ever displayed as text (a JSON string
// is never markup), in its own direction; numbers, TRNs and references sit in left-to-right isolates.
//
// Step 8 reads what a quotation never has, when present: `dueDate` (the details box), `references`
// ({ label, value }: the invoice a credit note corrects, its date…), `payments` (beside the totals) and
// `opening: none` (no "Dear …" line: the date goes into the details box).

#let data = json("/data.json")
#let lh = data.letterhead
#let accent = rgb(lh.accent)
#let tint = accent.lighten(93%)
#let tint-area = accent.lighten(86%)
#let rule = luma(222)
#let ink = luma(30)
#let body-ink = luma(55)
#let muted = luma(108)
#let red = rgb("#B42318")
#let rtl-doc = data.locale == "ar"
// The document's own sides (physical, so a paragraph set in the other direction still lines up).
#let ds = if rtl-doc { right } else { left }
#let de = if rtl-doc { left } else { right }
#let is-quotation = data.kind == "quotation"
#let is-credit = data.kind.ends-with("credit_note")
#let open = data.at("opening", default: none)

// Page geometry (A4): the letterhead's bands and the margins they leave for the content.
#let page-w = 210mm
#let page-h = 297mm
#let margin-x = 14mm
#let content-w = page-w - 2 * margin-x
#let has-logo = lh.logo != none and data.images.at(lh.logo, default: none) != none
#let foot-h = 32mm

#set document(
  title: data.title.en + " " + data.number,
  author: if lh.nameEn != none { lh.nameEn.text } else if lh.nameAr != none { lh.nameAr.text } else { "" },
  date: datetime(
    year: data.issuedAt.year, month: data.issuedAt.month, day: data.issuedAt.day,
    hour: data.issuedAt.hour, minute: data.issuedAt.minute, second: data.issuedAt.second,
  ),
)
#set text(
  font: ("IBM Plex Sans", "IBM Plex Sans Arabic"),
  size: 8.4pt,
  fill: ink,
  lang: if rtl-doc { "ar" } else { "en" },
  dir: if rtl-doc { rtl } else { ltr },
  number-type: "lining",
  number-width: "tabular",
)
#set par(leading: 0.5em, spacing: 0.7em)

// ------------------------------------------------------------------------------------------------
// Text helpers
// ------------------------------------------------------------------------------------------------

#let dir-of(t) = if t.dir == "rtl" { rtl } else { ltr }
#let lang-of(t) = if t.dir == "rtl" { "ar" } else { "en" }
#let has-arabic(s) = s.match(regex("[\u{0600}-\u{06FF}\u{0750}-\u{077F}\u{FB50}-\u{FDFF}\u{FE70}-\u{FEFF}]")) != none
// First-strong isolate (FSI … PDI): a name keeps its own direction inside a sentence, and may wrap.
#let fsi(s) = "\u{2068}" + s + "\u{2069}"

// One line of typed details: a short label before ": " is bold ("Material: …"), as on the owner's
// letterhead quotation. Only the text's own characters are printed.
#let detail-line(s) = {
  let m = s.match(regex("^([^:\n]{1,28}?):\s+(.+)$"))
  if m != none and m.captures.at(0).match(regex("\d")) == none {
    text(weight: "bold", fill: ink)[#m.captures.at(0):]
    [ ]
    [#m.captures.at(1)]
  } else { [#s] }
}
// The direction of a line's first strong character (the text's own direction when it has none).
#let line-dir(s, fallback) = {
  let a = s.position(regex("[\u{0590}-\u{08FF}\u{FB1D}-\u{FDFF}\u{FE70}-\u{FEFF}]"))
  let l = s.position(regex("[A-Za-z\u{00C0}-\u{024F}\u{0370}-\u{03FF}\u{0400}-\u{04FF}]"))
  if a == none and l == none { fallback } else if l == none { "rtl" } else if a == none { "ltr" } else if a < l { "rtl" } else { "ltr" }
}
// Typed text as a block on the document's start side, its line breaks kept, each line in the
// direction of its own first strong character (an IBAN line under Arabic bank details reads right).
// Each line is its own block, so a description taller than a page still breaks across pages whole.
#let typed(t, labels: false, gap: 0.45em, ..style) = if t == none { none } else if not t.text.contains("\n") {
  // One line: its direction is the text's own (the server read its first strong character).
  block(above: gap, below: gap, align(ds, text(dir: dir-of(t), lang: lang-of(t), ..style,
    if labels { detail-line(t.text) } else { [#t.text] })))
} else {
  for l in t.text.split("\n") {
    let d = line-dir(l, t.dir)
    block(above: gap, below: gap, align(ds, text(dir: if d == "rtl" { rtl } else { ltr },
      lang: if d == "rtl" { "ar" } else { "en" }, ..style, if labels { detail-line(l) } else { [#l] })))
  }
}
// Typed text fitted to the width of its cell (D-295), called in a context: a run of letters
// with no break point wider than the cell (a long code, or text typed to run out of it) gets
// zero-width break points where the cell is full, so it wraps inside its cell however wide the number
// columns beside it grow (an amount of ten digits narrows the description). The server already gave
// every long run break points at a length that fits the usual cell (build.ts, RUN); only when one of
// its pieces is wider than this cell is the run broken again, as one, where the cell is full (so its
// lines stay even). Only a run that could be too wide is measured: one with more letters than the cell
// holds at 2 em a letter (no letter of the fonts is wider but two Arabic ligatures, U+FDFB and
// U+FDFD), in bold (the widest the text prints).
#let bold-w(s, size) = measure(text(weight: "bold", size: size, s)).width
// A run between spaces longer than `most` letters (\S takes the server's zero-width break points in).
#let long-run(most) = regex("\S{" + str(most + 1) + ",}|\S*[\u{FDFB}\u{FDFD}]\S*")
#let fit-run(run, room, size) = {
  let pieces = ()
  let piece = ""
  let taken = 0pt
  for c in run.clusters() {
    let w = bold-w(c, size)
    if piece != "" and taken + w > room {
      pieces.push(piece)
      piece = ""
      taken = 0pt
    }
    piece += c
    taken += w
  }
  pieces.push(piece)
  pieces.join("\u{200B}")
}
#let fit(t, width, size) = if t == none or width > page-w { t } else {
  // A little room kept: letters measured one by one join (Arabic) or kern slightly wider.
  let room = width * 0.92
  (..t, text: t.text.replace(long-run(calc.max(1, calc.floor(room / (2 * size)))), m => {
    let pieces = m.text.split("\u{200B}")
    if pieces.all(p => bold-w(p, size) <= room) { m.text } else { fit-run(pieces.join(), room, size) }
  }))
}
// Typed text in a cell, fitted to the cell's width (measured where it is laid out).
#let typed-fit(t, size: 8.4pt, ..style) = if t == none { none } else {
  layout(cell => typed(fit(t, cell.width, size), size: size, ..style))
}
// Typed text as an inline isolate (a name inside a line).
#let iso(t, ..style) = if t == none { none } else {
  box(text(dir: dir-of(t), lang: lang-of(t), ..style)[#t.text])
}
// Numbers, amounts, TRNs and references: a left-to-right isolate.
#let ltr-iso(s, ..style) = box(text(dir: ltr, lang: "en", ..style)[#s])
// A longer left-to-right value (a customer's reference, an email): a paragraph of its own on the
// document's start side, so it wraps inside its cell (the server gave a long run break points).
#let ltr-wrap(s, ..style) = align(ds, block(text(dir: ltr, lang: "en", ..style)[#s]))
// A unit as given ("m²", "قطعة"): its own direction.
#let unit-iso(s, ..style) = if has-arabic(s) {
  box(text(dir: rtl, lang: "ar", ..style)[#s])
} else { box(text(dir: ltr, lang: "en", ..style)[#s]) }
// One language of a bilingual label, as an isolate.
#let en(b, ..style) = box(text(lang: "en", dir: ltr, ..style)[#b.en])
#let ar(b, ..style) = box(text(lang: "ar", dir: rtl, ..style)[#b.ar])
// The business's language first, then the other.
#let first(b, ..style) = if rtl-doc { ar(b, ..style) } else { en(b, ..style) }
#let second(b, ..style) = if rtl-doc { en(b, ..style) } else { ar(b, ..style) }
// A sentence in one language, as a block on the document's start side (it wraps).
#let say(b, lang, ..style) = align(ds, if lang == "ar" {
  text(lang: "ar", dir: rtl, ..style)[#b.ar]
} else {
  text(lang: "en", dir: ltr, ..style)[#b.en]
})
#let say-first(b, ..style) = say(b, if rtl-doc { "ar" } else { "en" }, ..style)
#let say-second(b, ..style) = say(b, if rtl-doc { "en" } else { "ar" }, ..style)
// A bilingual label on one line, and on two lines (table heads, captions).
#let bi(b, sep: "·", ..style) = box[#first(b, ..style)#h(3pt)#text(fill: muted, size: 0.85em)[#sep]#h(3pt)#second(b, ..style)]
#let bi2(b, size: 7pt, fill2: muted, at: ds, gap: 2.4pt, ..style) = align(at, stack(dir: ttb, spacing: gap,
  align(at, first(b, size: size, ..style)),
  align(at, second(b, size: size - 0.9pt, fill: fill2)),
))
// A label: the server's (both languages), or the template's own for a key Step 8 has yet to add.
#let L(key, en: none, ar: none) = data.labels.at(key, default: (en: en, ar: ar))
// A bilingual value (a date) or a plain one (a number), as printed in the details box.
#let value-of(v, ..style) = if type(v) == dictionary { first(v, ..style) } else { ltr-iso(v, ..style) }
#let img(key, ..args) = {
  let file = data.images.at(key, default: none)
  if file == none { none } else { image(file.path, format: file.format, ..args) }
}
// A caption over a block: the first language bold in the accent, the second lighter after it.
#let caption(b) = block(below: 2mm, {
  box(text(fill: accent, weight: "bold", size: 8pt)[#first(b)])
  h(4pt)
  box(text(fill: accent.lighten(25%), size: 7.4pt)[#second(b)])
})
// About how many printed lines a text takes at `per` characters a line (each typed line at least
// one): a cheap first sieve. A row or a block that could be taller than a page is measured against
// the page (D-295): kept whole when it fits on one, else allowed to break, so nothing is ever cut or
// drawn over the footer (D-224: an unbreakable block taller than a page runs off it).
#let est-lines(t, per) = if t == none { 0 } else {
  t.text.split("\n").map(r => calc.max(1, calc.ceil(r.clusters().len() / per))).sum()
}

// ------------------------------------------------------------------------------------------------
// The letterhead (every page)
// ------------------------------------------------------------------------------------------------

#let icon(shape) = {
  let svg = if shape == "phone" {
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1l-2.3 2.2z' fill='{c}'/></svg>"
  } else if shape == "email" {
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M3 5h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm9 7.2L20 7H4l8 5.2zM4 9.2V17h16V9.2l-8 5.2-8-5.2z' fill='{c}'/></svg>"
  } else {
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M12 2a7 7 0 0 1 7 7c0 5.2-7 13-7 13S5 14.2 5 9a7 7 0 0 1 7-7zm0 4.4A2.6 2.6 0 1 0 12 11.6 2.6 2.6 0 0 0 12 6.4z' fill='{c}'/></svg>"
  }
  box(baseline: 1.6pt, image(bytes(svg.replace("{c}", accent.to-hex())), format: "svg", height: 8.4pt))
}

// The top: in each corner a bold bar cut on the diagonal with a thinner one under it (their cuts on
// one 45° line), and a thin rule joining the two corners.
#let bars-top = {
  let corner(flip) = {
    let x(v) = if flip { page-w - v } else { v }
    place(top + left, polygon(fill: accent, (x(0mm), 0mm), (x(60mm), 0mm), (x(51mm), 9mm), (x(0mm), 9mm)))
    place(top + left, polygon(fill: accent, (x(0mm), 11mm), (x(49mm), 11mm), (x(47mm), 13mm), (x(0mm), 13mm)))
  }
  corner(false)
  corner(true)
  place(top + left, dx: 64mm, dy: 4.3mm, line(length: page-w - 128mm, stroke: 0.7pt + accent))
}

// The bottom: the bars in the end corner, a thin rule across the rest.
#let bars-bottom = {
  let x(v) = if rtl-doc { v } else { page-w - v }
  place(top + left, polygon(fill: accent,
    (x(0mm), page-h), (x(66mm), page-h), (x(57mm), page-h - 9mm), (x(0mm), page-h - 9mm)))
  place(top + left, polygon(fill: accent,
    (x(0mm), page-h - 11mm), (x(55mm), page-h - 11mm), (x(53mm), page-h - 13mm), (x(0mm), page-h - 13mm)))
  let len = page-w - 70mm
  place(top + left, dx: if rtl-doc { 70mm } else { 0mm }, dy: page-h - 4.6mm, line(length: len, stroke: 0.7pt + accent))
}

// The logo, large and light behind the content; a draft's mark takes its place (never both).
#let watermark = if not data.draft and lh.watermark and has-logo {
  let file = data.images.at(lh.logo)
  let size = 128mm
  place(center + horizon, dy: 8mm, box(width: size, height: size, {
    place(center + horizon, image(file.path, format: file.format, width: size, height: size, fit: "contain"))
    // Typst images have no opacity: a white veil over the logo (behind the content) keeps it light.
    place(center + horizon, rect(width: size + 1mm, height: size + 1mm, fill: white.transparentize(6%), stroke: none))
  }))
}

#let draft-mark = if data.draft {
  let label = L("draft", en: "Draft", ar: "مسودة")
  let both = (en: upper(label.en), ar: label.ar)
  place(center + horizon, dy: 8mm, rotate(-32deg, text(size: 64pt, weight: "bold", fill: luma(232),
    box[#first(both)#h(18pt)#second(both)])))
}

// A business name as large as `size`, made smaller to fit `width` but never below `least`; a name
// still too long then wraps to two lines of about the same length (a long legal name stays legible).
// Measures, so it is called in a context (once, by the page set-up below; never on every page).
#let name-line(n, size) = iso(n, weight: "bold", fill: ink, size: size, top-edge: "ascender", bottom-edge: "descender")
#let name-text(n, size, body) = text(dir: dir-of(n), lang: lang-of(n), weight: "bold", fill: ink, size: size, top-edge: "ascender", bottom-edge: "descender", body)
#let fitted-name(n, width, size, least) = {
  let w = measure(name-line(n, size)).width
  let shrunk = size * (width / w)
  let words = n.text.split(" ").filter(s => s != "")
  if w <= width {
    name-line(n, size)
  } else if shrunk >= least {
    name-line(n, shrunk)
  } else if words.len() < 2 {
    block(width: width, align(center, name-text(n, least, n.text)))
  } else {
    let part(a, b) = words.slice(a, b).join(" ")
    let widest(k) = calc.max(
      measure(name-line((text: part(0, k), dir: n.dir), size)).width,
      measure(name-line((text: part(k, words.len()), dir: n.dir), size)).width,
    )
    let best = range(1, words.len()).fold(1, (k, i) => if widest(i) < widest(k) { i } else { k })
    let line-size = calc.max(least, calc.min(size, size * (width / widest(best))))
    // At the least size a half may still be too wide: it then wraps inside the names' width.
    stack(dir: ttb, spacing: 0.8mm,
      block(width: width, align(center, name-text(n, line-size, part(0, best)))),
      block(width: width, align(center, name-text(n, line-size, part(best, words.len())))),
    )
  }
}

// The seller's own identity on every page: «TRN 100… الرقم الضريبي | Trade licence DED-… الرخصة
// التجارية», English and Arabic around each value, the values in left-to-right isolates.
#let seller-ids = {
  let items = ()
  if lh.trn != none { items.push(("trn", lh.trn)) }
  if lh.tradeLicence != none { items.push(("tradeLicence", lh.tradeLicence)) }
  if items.len() > 0 {
    let one = ((key, value)) => {
      let b = L(key)
      box[#en(b, fill: muted)#h(1.6mm)#ltr-iso(value, weight: "bold", fill: ink)#h(1.6mm)#ar(b, fill: muted)]
    }
    text(size: 7pt, dir: ltr, items.map(one).join(box(inset: (x: 2.6mm), text(fill: accent)[|])))
  }
}

// The English and Arabic names under the logo, then the seller's TRN and licence; without a logo the
// names alone, larger, with a short accent rule between them. Called in a context (it measures).
#let names = (lh.nameEn, lh.nameAr).filter(n => n != none)
#let names-w = content-w - 16mm
#let header-body() = {
  set align(center)
  if has-logo {
    stack(dir: ttb, spacing: 0.7mm, ..names.map(n => align(center,
      fitted-name(n, names-w, if n.dir == "rtl" { 12.6pt } else { 12pt }, 9.5pt))))
  } else {
    let rows = names.map(n => align(center, fitted-name(n, names-w, if n.dir == "rtl" { 17pt } else { 16.5pt }, 11pt)))
    let parts = if rows.len() == 2 {
      (rows.at(0), align(center, box(height: 3.4mm, align(horizon, line(length: 24mm, stroke: 1.2pt + accent)))), rows.at(1))
    } else { rows }
    stack(dir: ttb, spacing: 0.4mm, ..parts)
  }
  if seller-ids != none {
    v(if has-logo { 1.2mm } else { 1.8mm })
    seller-ids
  }
}
#let logo-top = 8.5mm
#let logo-h = 17mm
// Without a logo the names start just under the top bars (a long name runs under the corners).
#let names-top = if has-logo { logo-top + logo-h + 1.6mm } else { 14.5mm }
#let logo-mark = if has-logo {
  place(top + center, dy: logo-top, box(width: 70mm, height: logo-h,
    align(center + horizon, img(lh.logo, width: 70mm, height: logo-h, fit: "contain"))))
}

// The contact lines in a rounded bracket on the start side, and the height they take from the page's
// foot (the bottom margin keeps the content above them, however long the address). Called in a
// context (it measures).
#let footer-contacts() = {
  let items = ()
  if lh.phones.len() > 0 {
    items.push((icon("phone"), ltr-iso(lh.phones.join("   |   "))))
  }
  if lh.email != none { items.push((icon("email"), ltr-wrap(lh.email))) }
  if lh.address != none { items.push((icon("pin"), typed(lh.address, gap: 0pt))) }
  if items.len() == 0 { (content: none, height: 0mm) } else {
    let body = text(size: 7.5pt, fill: ink, grid(
      columns: (auto, 108mm),
      column-gutter: 2.2mm,
      row-gutter: 1.6mm,
      align: (center + horizon, ds + horizon),
      ..items.flatten(),
    ))
    let size = measure(body)
    let hgt = size.height + 5mm
    let tick = 9mm
    let r = 2.6mm
    let bracket = if rtl-doc {
      curve(stroke: 1.1pt + accent,
        curve.move((0mm, 0mm)), curve.line((tick - r, 0mm)), curve.quad((tick, 0mm), (tick, r)),
        curve.line((tick, hgt - r)), curve.quad((tick, hgt), (tick - r, hgt)), curve.line((0mm, hgt)))
    } else {
      curve(stroke: 1.1pt + accent,
        curve.move((tick, 0mm)), curve.line((r, 0mm)), curve.quad((0mm, 0mm), (0mm, r)),
        curve.line((0mm, hgt - r)), curve.quad((0mm, hgt), (r, hgt)), curve.line((tick, hgt)))
    }
    let top-y = page-h - 10.5mm - hgt
    let drawn = if rtl-doc {
      place(top + left, dx: page-w - margin-x - tick, dy: top-y, bracket)
      place(top + left, dx: page-w - margin-x - 3.6mm - size.width, dy: top-y + 2.5mm, body)
    } else {
      place(top + left, dx: margin-x, dy: top-y, bracket)
      place(top + left, dx: margin-x + 3.6mm, dy: top-y + 2.5mm, body)
    }
    (content: drawn, height: 10.5mm + hgt)
  }
}

// The document's number and "Page x of y" on the end side, so pages that come apart can be matched.
#let page-label = L("page", en: "Page {{page}} of {{pages}}", ar: "صفحة {{page}} من {{pages}}")
#let page-mark = context {
  let here = str(counter(page).get().first())
  let total = str(counter(page).final().first())
  let page-text = (
    en: page-label.en.replace("{{page}}", here).replace("{{pages}}", total),
    ar: page-label.ar.replace("{{page}}", here).replace("{{pages}}", total),
  )
  place(top + left, dx: margin-x, dy: page-h - 23mm,
    block(width: content-w, align(de, stack(dir: ttb, spacing: 1.5mm,
      align(de, ltr-iso(data.number, size: 7.2pt, weight: "bold", fill: muted)),
      align(de, text(size: 7.2pt, fill: muted)[#first(page-text)]),
    ))))
}

// The page's frame: the letterhead's names fitted and its contact lines measured, the margins they
// leave (the content starts under the names, however tall they come out, and ends above the contact
// lines, however long the address) and the content's height on a page. Called in a context.
#let page-frame() = {
  let header = header-body()
  let head = measure(block(width: content-w, header)).height
  let contacts = footer-contacts()
  let top = names-top + head + 5.5mm
  let bottom = calc.max(foot-h, contacts.height + 3mm)
  (header: header, contacts: contacts.content, top: top, bottom: bottom, body: page-h - top - bottom)
}

// The letterhead is made once, then drawn on every page.
#show: doc => context {
  let frame = page-frame()
  set page(
    paper: "a4",
    margin: (top: frame.top, bottom: frame.bottom, x: margin-x),
    background: {
      watermark
      draft-mark
      bars-top
      bars-bottom
      logo-mark
      place(top + center, dy: names-top, block(width: content-w, frame.header))
      frame.contacts
      page-mark
    },
  )
  doc
}

// ------------------------------------------------------------------------------------------------
// Title, the customer and the document's details
// ------------------------------------------------------------------------------------------------

// The title in both languages, centred between two thin rules.
#block(below: 3.2mm, grid(
  columns: (1fr, auto, 1fr),
  column-gutter: 4mm,
  align: horizon,
  line(length: 100%, stroke: 0.5pt + accent.lighten(40%)),
  box({
    first(data.title, size: 15pt, weight: "bold", fill: accent)
    h(3.5mm)
    box(height: 11pt, baseline: 1.5pt, line(angle: 90deg, length: 11pt, stroke: 0.8pt + accent.lighten(40%)))
    h(3.5mm)
    second(data.title, size: 15pt, weight: "bold", fill: accent)
  }),
  line(length: 100%, stroke: 0.5pt + accent.lighten(40%)),
))

#let field(key, value) = (
  align(ds + horizon, text(fill: muted, size: 7.2pt)[#bi(L(key))]),
  align(ds + horizon, value),
)

#let customer-block = {
  let c = data.customer
  let rows = ()
  if c.site != none { rows += field("site", typed(c.site, gap: 0pt)) }
  if c.phone != none { rows += field("phone", ltr-iso(c.phone)) }
  if c.trn != none { rows += field("trn", ltr-iso(c.trn, weight: "bold")) }
  if c.address != none { rows += field("address", typed(c.address, gap: 0pt)) }
  let to = if is-quotation { L("to") } else { L("billTo", en: "Bill to", ar: "فاتورة إلى") }
  align(ds, stack(dir: ttb, spacing: 2mm,
    align(ds, bi(to, fill: accent, weight: "bold", size: 7.4pt)),
    typed(c.name, size: 11.5pt, weight: "bold", gap: 0pt),
    if rows.len() > 0 { grid(columns: (auto, 1fr), column-gutter: 3.5mm, row-gutter: 1.3mm, ..rows) },
  ))
}

#let details-block = {
  let rows = ()
  let number-label = if is-quotation { "number.quotation" } else if is-credit { "number.creditNote" } else { "number.invoice" }
  rows += field(number-label, ltr-iso(data.number, weight: "bold", size: 9.6pt))
  if data.revision != none { rows += field("revision", ltr-iso(str(data.revision))) }
  // A quotation dates its "Dear …" line (as the owner's letterhead); an invoice dates its details.
  if open == none { rows += field("date", first(data.date, weight: "bold")) }
  let due = data.at("dueDate", default: none)
  if due != none { rows += field("dueDate", first(due, weight: "bold")) }
  if data.validUntil != none { rows += field("validUntil", first(data.validUntil)) }
  if data.customerRef != none { rows += field("customerRef", ltr-wrap(data.customerRef)) }
  // Step 8's own references (the supply date, the invoice a credit note corrects…), when given.
  for r in data.at("references", default: ()) {
    rows.push(align(ds + horizon, text(fill: muted, size: 7.2pt)[#bi(r.label)]))
    rows.push(align(ds + horizon, value-of(r.value)))
  }
  (natural: grid(columns: (auto, auto), column-gutter: 4mm, row-gutter: 1.3mm, ..rows),
   fitted: grid(columns: (auto, 1fr), column-gutter: 4mm, row-gutter: 1.3mm, ..rows))
}

// The details take what they need up to 78 mm (a long reference wraps there); the customer the rest.
#context {
  let details-w = calc.min(measure(details-block.natural).width, 78mm)
  block(
    width: 100%,
    fill: tint,
    radius: 2mm,
    inset: (x: 4mm, y: 2.6mm),
    below: 3.6mm,
    grid(
      columns: (1fr, details-w + 5mm + 0.5pt),
      column-gutter: 6mm,
      customer-block,
      block(
        width: 100%,
        stroke: if rtl-doc { (right: 0.5pt + accent.lighten(60%)) } else { (left: 0.5pt + accent.lighten(60%)) },
        inset: if rtl-doc { (right: 5mm, y: 0.5mm) } else { (left: 5mm, y: 0.5mm) },
        details-block.fitted),
    ),
  )
}

// ------------------------------------------------------------------------------------------------
// The opening: "Dear …," with the date on the other side, then the sentences after it
// ------------------------------------------------------------------------------------------------

// "Dear {{name}}," in the business's language («السادة / {{name}}،»: right for a company, a man or a
// woman), the customer's name and the project each in its own first-strong isolate: one isolate
// around both would turn "Arabic name – Latin site" round. A greeting typed on the document prints as
// typed.
#let greeting = if open != none {
  let typed-greeting = open.at("greeting", default: none)
  if typed-greeting != none {
    typed(typed-greeting, weight: "bold", size: 9pt, gap: 0pt)
  } else {
    let label = L("dear")
    let parts = (if rtl-doc { label.ar } else { label.en }).split("{{name}}")
    let c = data.customer
    let named = fsi(c.name.text) + if c.site != none { " – " + fsi(c.site.text) } else { "" }
    align(ds, text(lang: if rtl-doc { "ar" } else { "en" }, weight: "bold", size: 9pt,
      parts.first() + named + parts.at(1, default: "")))
  }
}

#if open != none {
  block(breakable: false, below: 3.2mm)[
    #grid(
      columns: (1fr, auto),
      column-gutter: 6mm,
      align(ds + bottom, greeting),
      align(de + bottom, text(fill: muted)[#bi(L("date")) #h(4pt) #first(data.date, fill: ink, weight: "bold")]),
    )
    #v(0.4mm)
    #set text(fill: body-ink)
    #if "text" in open.intro {
      typed(open.intro, gap: 0.35em)
      say-first(open.amountsIn, fill: muted)
    } else {
      let lang1 = if rtl-doc { "ar" } else { "en" }
      let lang2 = if rtl-doc { "en" } else { "ar" }
      let both = (en: open.intro.en + " " + open.amountsIn.en, ar: open.intro.ar + " " + open.amountsIn.ar)
      say(both, lang1)
      v(-0.9mm)
      say(both, lang2, fill: muted, size: 7.8pt)
    }
  ]
}

// ------------------------------------------------------------------------------------------------
// The lines: No. | Picture | Area | Description | Unit price | Qty | (Discount) | (VAT) | Amount
// ------------------------------------------------------------------------------------------------

#let t = data.table
#let show-pics = t.showPictures and data.lines.any(l => l.picture != none and data.images.at(l.picture, default: none) != none)
#let show-areas = t.showAreas and data.lines.any(l => l.area != none)
// Every line's picture in one frame, the same on every line (D-299: «تتضبط تلقائي بنفس المقاس»): 20 ×
// 15 mm (4:3, the shape the browser saves each picture in, QUOTATION_PICTURE_WIDTH × HEIGHT), filled
// whatever the picture's own shape (a centred crop: never stretched, never with bands).
#let pic-w = 20mm
#let pic-h = 15mm
#let pic-pad = 1.1mm
// The area column, the room across it for an area's name written up its side (inside its insets) and
// the cell's inset along it.
#let area-w = 8.5mm
#let area-room = area-w - 2 * 0.6mm
#let area-inset = 1.5mm
// The quantity, then its unit in a box as wide as the longest unit (estimated from its letters, so
// nothing is measured), so the quantities line up.
#let unit-w = data.lines.filter(l => l.unit != none).map(l => l.unit.clusters().len() * 1.55mm + 0.6mm).fold(0mm, (a, b) => calc.max(a, b))
#let columns = (
  (7.5mm,),
  if show-pics { (pic-w + 2 * pic-pad,) } else { () },
  if show-areas { (area-w,) } else { () },
  (1fr, auto, auto),
  if t.showDiscount { (auto,) } else { () },
  if t.showVat { (auto,) } else { () },
  (auto,),
  // An empty column 0 pt wide: its unbreakable cells keep the first and the last lines of a long area
  // on one page (area-plan), so no page holds a piece of an area too short for its name.
  if show-areas { (0pt,) } else { () },
).flatten()
#let head(key, at: ds) = bi2(L(key), size: 7.3pt, fill: white, weight: "bold", fill2: white.transparentize(22%), at: at, gap: 2.2pt)
#let num-at = right
// The heads of the number columns, after the description's.
#let number-heads = (
  head("table.unitPrice", at: num-at),
  head("table.qty", at: num-at),
  ..if t.showDiscount { (head("table.discount", at: num-at),) } else { () },
  ..if t.showVat { (head("table.vat", at: num-at),) } else { () },
  head("table.amount", at: num-at),
)
#let head-cells = (
  head("table.no", at: center),
  ..if show-pics { (table.cell(inset: (x: pic-pad, y: 1.9mm), head("table.picture", at: center)),) } else { () },
  ..if show-areas { (table.cell(inset: (x: 0.6mm, y: 1.9mm), head("table.area", at: center)),) } else { () },
  head("table.description"),
  ..number-heads,
  ..if show-areas { (table.cell(inset: 0pt, []),) } else { () },
)

// Where an area ends (not where a page splits it): a slightly stronger rule closes it. A dictionary
// of the rows (by line index) that close one, read for each cell's stroke.
#let area-ends = {
  let ends = (:)
  for (i, line) in data.lines.enumerate() {
    let next = data.lines.at(i + 1, default: none)
    let key = if line.area == none { none } else { line.area.text }
    let next-key = if next == none or next.area == none { none } else { next.area.text }
    if next != none and (key != none or next-key != none) and key != next-key { ends.insert(str(i), true) }
  }
  ends
}
// An area's name, bold in the accent and in its own direction, at `size`: 8.2 pt, smaller for a long
// name in a short cell (never below 6.2 pt but in a cell shorter than it was planned for).
#let area-size = 8.2pt
#let area-least = 6.2pt
// Measured by its letters' own bounds, so a wrapped name's height across the column is the height its
// ink takes (an Arabic name's deep descenders included).
#let area-text(t, size) = text(dir: dir-of(t), lang: lang-of(t), hyphenate: false, weight: "bold",
  size: size, fill: accent.darken(8%), top-edge: "bounds", bottom-edge: "bounds", t.text)
#let area-block(t, w, size) = block(width: w, {
  set par(leading: 0.3em)
  align(center, area-text(t, size))
})
#let area-up(body) = rotate(if rtl-doc { 90deg } else { -90deg }, reflow: true, body)
// What an area's name needs, measured once (called in a context): its length on one line at 8.2 pt
// (`natural`); the least length it takes wrapped across the column at 6.2 pt (`wrap`: never shorter
// than its widest word, so no word runs out of its cell); and the length it asks of a cell whose lines
// are shorter (`grow`: a short name at its full size, as before D-299; a longer one wrapped). None: a
// name that draws nothing (only invisible characters), printed as no name.
#let area-needs(t) = {
  let natural = measure(area-text(t, area-size)).width
  if natural <= 0pt { return none }
  let one = measure(area-text(t, area-least)).width
  let words = t.text.split(regex("[\s\u{200B}]+")).filter(s => s != "")
  let widest = words.map(s => measure(area-text((text: s, dir: t.dir), area-least)).width).fold(0pt, (a, b) => calc.max(a, b))
  let fits(w) = measure(area-block(t, w, area-least)).height <= area-room
  let wrap = if fits(widest) { widest } else {
    let lo = widest
    let hi = one + 1pt
    for _ in range(12) {
      let mid = (lo + hi) / 2
      if fits(mid) { hi = mid } else { lo = mid }
    }
    hi
  }
  (natural: natural, wrap: wrap, grow: if natural <= 18mm { natural } else { wrap })
}
// The name along a cell `length` long (inside its insets): on one line as large as fits (8.2 pt down
// to 6.2 pt); else wrapped across the column at 6.2 pt, in as few lines as fit and those as even as
// they can be; else (a cell shorter than its plan, never in a settled layout) smaller still. Never
// longer than its cell.
#let area-fitted(t, needs, length) = if needs == none or length <= 0pt { none } else {
  let size = calc.max(area-least, calc.min(area-size, area-size * (length / needs.natural) * 0.99))
  if measure(area-text(t, size)).width <= length {
    block(width: length, align(center, area-text(t, size)))
  } else if needs.wrap <= length {
    let across(w) = measure(area-block(t, w, area-least)).height
    let fewest = across(length)
    let lo = needs.wrap
    let hi = length
    for _ in range(10) {
      let mid = (lo + hi) / 2
      if across(mid) <= fewest { hi = mid } else { lo = mid }
    }
    area-block(t, hi, area-least)
  } else {
    area-block(t, length, area-least * (length / needs.wrap))
  }
}

// The title, its details (line breaks kept, "Material:" bold) and the note in red. Blocks, not a
// stack: a row taller than a page breaks across pages and prints whole (D-224). Each fitted to the
// description column's width `w` (desc-width), called in a context.
#let description(line, w) = {
  block(below: 1.5mm, typed(fit(line.title, w, 8.7pt), weight: "bold", size: 8.7pt, gap: 0pt))
  if line.details != none { block(above: 1.5mm, below: 1.4mm, typed(fit(line.details, w, 7.9pt), labels: true, size: 7.9pt, fill: body-ink, gap: 0.42em)) }
  if line.note != none { block(above: 1.4mm, typed(fit(line.note, w, 7.7pt), fill: red, weight: "bold", size: 7.7pt, gap: 0.42em)) }
}
// A row stays on one page unless its description is taller than a page (then it breaks, so no text is
// ever cut or drawn over the footer). Only a description long enough to come near a page is measured,
// in the description column's width as the table lays it out.
#let maybe-tall = data.lines.enumerate().filter(((i, l)) =>
  est-lines(l.title, 60) + est-lines(l.details, 70) + est-lines(l.note, 70) > 12).map(((i, l)) => i)
#let unit-of(line) = unit-iso(line.unit, fill: muted, size: 7.6pt)
#let qty-cell(line) = box(text(dir: if rtl-doc { rtl } else { ltr }, {
  ltr-iso(line.qty)
  if unit-w > 0mm { h(2.2pt); box(width: unit-w, align(ds, if line.unit != none { unit-of(line) })) }
}))

// A line's amount; a price typed with VAT says so under it (the totals are before VAT).
#let amount-cell(line) = if line.at("includesVat", default: false) {
  align(num-at, stack(dir: ttb, spacing: 1.3mm,
    align(num-at, ltr-iso(line.amount, weight: "bold")),
    bi2(L("table.inclVat", en: "incl. VAT", ar: "شامل الضريبة"), size: 6.2pt, at: num-at, gap: 1.2pt)))
} else { align(num-at, ltr-iso(line.amount, weight: "bold")) }
// A line's number cells: price, quantity with its unit, (discount), (VAT), amount.
#let number-cells(line) = (
  align(num-at, ltr-iso(line.unitPrice)),
  align(num-at, qty-cell(line)),
  ..if t.showDiscount { (align(num-at, ltr-iso(if line.discount == none { "" } else { line.discount }, fill: muted)),) } else { () },
  ..if t.showVat { (align(num-at, ltr-iso(if line.vatRate == none { "" } else { line.vatRate }, fill: body-ink)),) } else { () },
  amount-cell(line),
)
// The description's width as the table lays it out (D-295), measured once and called in a context:
// the content width less every other column, each number column as wide as its widest cell (its head
// too) with its insets, as the table sizes an auto column, so long amounts narrow it.
#let desc-width() = {
  let widths = number-heads.map(h => measure(h).width)
  for line in data.lines {
    widths = number-cells(line).zip(widths).map(((cell, w)) => calc.max(w, measure(cell).width))
  }
  let others = 7.5mm + (if show-pics { pic-w + 2 * pic-pad } else { 0mm }) + (if show-areas { area-w } else { 0mm })
  calc.max(20mm, content-w - others - widths.map(w => w + 2 * 1.9mm).sum() - 2 * 1.9mm)
}
// The rows to let break: called in a context (it measures).
#let tall-rows(width) = if maybe-tall.len() == 0 { () } else {
  let limit = page-frame().body - 16mm
  maybe-tall.filter(i => measure(block(width: width, description(data.lines.at(i), width))).height > limit)
}

// The least height of a line's row, as the table lays it out (its description in the column's width
// `w`): its picture's frame, its description or its amount, with the cells' insets. A row is never
// shorter, so the area plan below never asks too little of a page.
#let row-low(line, w) = {
  let file = if show-pics and line.picture != none { data.images.at(line.picture, default: none) }
  calc.max(
    if file != none { pic-h + 2 * pic-pad } else { 0pt },
    measure(block(width: w, description(line, w))).height + 2 * 1.55mm,
    measure(amount-cell(line)).height + 2 * 1.55mm,
  )
}
// The areas (D-299: the owner sets which lines each holds, the server keeps them together): each run
// of consecutive lines in one area, with what its name needs and how its rows stay together. Planned
// from the lines alone, never from where the pages fall, so the layout settles: a name changes a
// row's height only in an area kept whole on one page.
//   - An area shorter than twice what its name needs stays whole on one page (its cell unbreakable),
//     and its cell is at least as long as its name asks (`floor`: its last row grows when its lines
//     are shorter, e.g. one line without a picture).
//   - A longer one may break across pages, but its first lines and its last, enough for the name, stay
//     together (the 0 pt column's unbreakable cells, `keep`), so each page's piece of it holds the name.
// Called in a context, with the description's width `w` and the rows let break (`tall`: never kept).
#let area-plan(w, tall) = {
  let runs = ()
  for (i, line) in data.lines.enumerate() {
    let key = if line.area == none { none } else { line.area.text }
    if key != none and runs.len() > 0 and runs.last().key == key and runs.last().start + runs.last().count == i {
      runs.last().count += 1
    } else if key != none {
      runs.push((key: key, start: i, count: 1))
    }
  }
  runs.map(run => {
    let needs = area-needs(data.lines.at(run.start).area)
    let rows = range(run.start, run.start + run.count)
    let lows = rows.map(i => row-low(data.lines.at(i), w))
    let plan = (..run, needs: needs, lows: lows, whole: false, floor: none, keep: ())
    if needs == none { return plan }
    let need = needs.wrap + 2 * area-inset + 0.6mm
    if lows.sum() < 2 * need and not rows.any(i => tall.contains(i)) {
      return (..plan, whole: true, floor: needs.grow)
    }
    // The first rows that hold the name, and the last (a row let break is never kept).
    let head = 0
    let taken = 0pt
    while head < run.count and taken < need and not tall.contains(run.start + head) {
      taken += lows.at(head)
      head += 1
    }
    let tail = 0
    taken = 0pt
    while tail < run.count - head and taken < need and not tall.contains(run.start + run.count - 1 - tail) {
      taken += lows.at(run.count - 1 - tail)
      tail += 1
    }
    let keep = ()
    if head > 1 { keep.push((start: run.start, count: head)) }
    if tail > 1 { keep.push((start: run.start + run.count - tail, count: tail)) }
    (..plan, keep: keep)
  })
}
// Each area cut where the pages break (each line's page read from the previous layout pass, one query
// for all of them), so every page names its area: its pieces, by the line each starts at.
#let area-pieces(plans, page-of) = {
  let pieces = (:)
  for plan in plans {
    let start = plan.start
    for i in range(plan.start + 1, plan.start + plan.count + 1) {
      if i == plan.start + plan.count or page-of(i) != page-of(i - 1) {
        pieces.insert(str(start), (plan: plan, start: start, count: i - start))
        start = i
      }
    }
  }
  pieces
}
// A piece's length inside its insets: from where its top and bottom were drawn in the previous layout
// pass (a name never moves them, so this is exact once the layout settles); else from its rows' least
// heights (the first pass), on its own page only (a piece that a long description carries over).
#let piece-length(piece, extents, content-bottom) = {
  let at = piece.start - piece.plan.start
  let planned = piece.plan.lows.slice(at, at + piece.count).sum() - 2 * area-inset
  if piece.plan.floor != none { planned = calc.max(planned, piece.plan.floor) }
  let e = extents.at(str(piece.start), default: (:))
  if "top" in e and "bottom" in e and e.top.page == e.bottom.page {
    e.bottom.y - e.top.y
  } else if "top" in e {
    calc.min(planned, content-bottom - area-inset - e.top.y)
  } else { planned }
}
// An area's cell: at least its floor long (an area kept whole), its top and bottom marked for the
// next pass, its name placed over it (a placed name never changes the cell's height).
#let area-cell(piece, length) = {
  if piece.plan.floor != none { box(width: 0pt, height: piece.plan.floor) }
  place(top, [#metadata((start: piece.start, edge: "top"))<bz-area>])
  place(bottom, [#metadata((start: piece.start, edge: "bottom"))<bz-area>])
  let name = area-fitted(data.lines.at(piece.start).area, piece.plan.needs, length)
  if name != none { place(center + horizon, area-up(name)) }
}

// Every line's cells but the area's, made once (the layout passes reuse them): before the area cell
// (No., picture) and after it (description, price, quantity, unit, discount, VAT, amount).
#let make-line-cells(tall, w) = data.lines.enumerate().map(((i, line)) => {
  let breakable = tall.contains(i)
  let before = (table.cell(breakable: breakable, align(center, [#ltr-iso(str(line.no), fill: muted)#if show-areas [#metadata(i)<bz-row>]])),)
  if show-pics {
    let file = if line.picture == none { none } else { data.images.at(line.picture, default: none) }
    before.push(table.cell(inset: (x: pic-pad, y: pic-pad), align(center + horizon, if file == none { [] } else {
      box(width: pic-w, height: pic-h, clip: true, radius: 1.8mm, stroke: 0.4pt + rule,
        image(file.path, format: file.format, width: pic-w, height: pic-h, fit: "cover"))
    })))
  }
  (before: before, after: (table.cell(breakable: breakable, description(line, w)), ..number-cells(line)))
})

// The table's body: each line's cells, an area's cell at the start of each of its pieces (a line
// without an area has an empty one), and the 0 pt column's cells (the kept rows' unbreakable ones).
#let body-cells(line-cells, plans: (), pieces: (:), extents: (:), content-bottom: 0pt) = {
  let keeps = (:)
  for plan in plans { for k in plan.keep { keeps.insert(str(k.start), k.count) } }
  let kept-to = -1
  let cells = ()
  for (i, line) in data.lines.enumerate() {
    let made = line-cells.at(i)
    cells += made.before
    if show-areas {
      let piece = pieces.at(str(i), default: none)
      if piece != none {
        cells.push(table.cell(rowspan: piece.count, fill: tint-area, stroke: (bottom: 1.6pt + white),
          breakable: if piece.plan.whole { false } else { auto },
          inset: (x: 0.6mm, y: area-inset), align: center + horizon,
          area-cell(piece, piece-length(piece, extents, content-bottom))))
      } else if line.area == none {
        cells.push(table.cell(inset: (x: 0.6mm, y: area-inset), []))
      }
    }
    cells += made.after
    if show-areas {
      let kept = keeps.at(str(i), default: none)
      if kept != none {
        cells.push(table.cell(rowspan: kept, breakable: false, inset: 0pt, []))
        kept-to = i + kept - 1
      } else if i > kept-to { cells.push(table.cell(inset: 0pt, [])) }
    }
  }
  cells
}

#let lines-table(body) = table(
  columns: columns,
  inset: (x: 1.9mm, y: 1.55mm),
  align: (x, y) => horizon + ds,
  stroke: (x, y) => if y == 0 { 0.6pt + accent } else if show-areas and str(y - 1) in area-ends {
    (bottom: 0.7pt + accent.lighten(55%))
  } else { (bottom: 0.4pt + rule) },
  fill: (x, y) => if y == 0 { accent } else { none },
  table.header(repeat: true, ..head-cells),
  ..body,
)

// Called in a context (the area plan measures).
#let render-lines(tall, w) = {
  let cells = make-line-cells(tall, w)
  if show-areas {
    let plans = area-plan(w, tall)
    let content-bottom = page-h - page-frame().bottom
    context {
      // Where the previous pass drew each line (its page) and each area cell (its top and bottom).
      let pages = (:)
      for mark in query(<bz-row>) { pages.insert(str(mark.value), mark.location().page()) }
      let extents = (:)
      for mark in query(<bz-area>) {
        let key = str(mark.value.start)
        let e = extents.at(key, default: (:))
        e.insert(mark.value.edge, mark.location().position())
        extents.insert(key, e)
      }
      let pieces = area-pieces(plans, i => pages.at(str(i), default: 0))
      lines-table(body-cells(cells, plans: plans, pieces: pieces, extents: extents, content-bottom: content-bottom))
    }
  } else {
    lines-table(body-cells(cells))
  }
}

#if data.lines.len() > 0 {
  context {
    let w = desc-width()
    render-lines(tall-rows(w), w)
  }
}

// ------------------------------------------------------------------------------------------------
// After the table: the payment terms (a quotation) or the payments received (an invoice) with the
// validity on the start side, the totals on the end side
// ------------------------------------------------------------------------------------------------

#let totals-block = {
  let rows = ()
  for row in data.totals {
    if row.strong {
      rows.push(table.cell(fill: accent, align(ds + horizon, bi(row.label, fill: white, weight: "bold", size: 8.6pt))))
      rows.push(table.cell(fill: accent, align(right + horizon, text(fill: white, weight: "bold")[#ltr-iso(data.currency, size: 7.2pt) #h(2pt) #ltr-iso(row.amount, size: 10.4pt)])))
    } else {
      rows.push(layout(size => {
        let one = box[#first(row.label, size: 8pt)#h(3pt)#text(fill: muted, size: 6.8pt)[·]#h(3pt)#second(row.label, size: 7.4pt, fill: muted)]
        align(ds + horizon, if measure(one).width <= size.width { one } else { bi2(row.label, size: 8pt, fill2: muted, gap: 2.6pt) })
      }))
      rows.push(align(right + horizon, ltr-iso(row.amount)))
    }
  }
  table(
    columns: (1fr, auto),
    inset: (x: 2.6mm, y: 1.45mm),
    align: horizon,
    stroke: (x, y) => (bottom: 0.4pt + rule),
    ..rows,
  )
}

#let small-table(heads, rows, nums: (), first-head-span: 1) = text(size: 8pt, table(
  columns: heads.map(k => k.at(1)),
  inset: (x: 1.7mm, y: 1.3mm),
  align: (x, y) => horizon + if nums.contains(x) { right } else { ds },
  stroke: (x, y) => (bottom: 0.4pt + rule),
  fill: (x, y) => if y == 0 { tint } else { none },
  ..heads.enumerate().map(((x, k)) => if k.at(0) == none { [] } else {
    bi2(k.at(0), size: 7pt, at: if nums.contains(x) { right } else { ds }, gap: 1.8pt)
  }),
  ..rows.flatten(),
))

// A stage's number in a small accent circle (①②③ on the owner's letterhead).
#let circled(n) = box(baseline: 1.3mm, width: 4.4mm, height: 4.4mm, radius: 50%, fill: accent,
  align(center + horizon, ltr-iso(str(n), fill: white, weight: "bold", size: 6.8pt)))

#let stages-block = if data.stages.len() > 0 {
  caption(L("stages.title"))
  small-table(
    ((none, auto), (L("stages.stage"), 1fr), (L("stages.due"), 1.3fr), (L("stages.percent"), auto), (L("stages.amount"), auto)),
    data.stages.enumerate().map(((i, s)) => (
      circled(i + 1),
      if "text" in s.label { typed-fit(s.label, size: 8pt, weight: "bold", gap: 0pt) } else { first(s.label, weight: "bold") },
      typed-fit(s.due, size: 8pt, gap: 0pt),
      ltr-iso(s.percent),
      ltr-iso(s.amount, weight: "bold"),
    )),
    nums: (3, 4),
  )
}

// Step 8: the payments an invoice has received, on the same page as its totals.
#let payments = data.at("payments", default: ())
#let payments-block = if payments.len() > 0 {
  caption(L("payments.title", en: "Payments received", ar: "الدفعات المستلمة"))
  small-table(
    ((L("payments.date", en: "Date", ar: "التاريخ"), auto), (L("payments.method", en: "Method", ar: "الطريقة"), 1fr),
     (L("payments.reference", en: "Reference", ar: "المرجع"), auto), (L("payments.amount", en: "Amount", ar: "المبلغ"), auto)),
    payments.map(p => (
      first(p.date),
      if "text" in p.method { iso(p.method) } else { first(p.method) },
      if p.reference == none { [] } else { ltr-iso(p.reference, fill: body-ink) },
      ltr-iso(p.amount, weight: "bold"),
    )),
    nums: (3,),
  )
}

#let validity-block = if data.validity != none {
  set text(fill: body-ink)
  say-first(data.validity)
  v(-1mm)
  say-second(data.validity, fill: muted, size: 7.6pt)
}

// ------------------------------------------------------------------------------------------------
// The closing: terms and notes (start side) beside the bank details (end side), then the signatory
// with the signature and the stamp, and room for the customer's acceptance. The bank details go
// beside the totals instead when the start side there is short (an invoice's payments), so the
// totals' row is used. When the terms are short the closing is kept whole, so the signature never
// stands alone on a last page: it moves with the terms it signs.
// ------------------------------------------------------------------------------------------------

#let section(b, body) = if body != none {
  block(width: 100%, breakable: true, above: 0mm, below: 3mm, {
    caption(b)
    typed(body, labels: true, fill: body-ink, gap: 0.45em)
  })
}
#let bank = if data.paymentDetails != none {
  block(width: 100%, fill: tint, radius: 2mm, inset: (x: 3.4mm, y: 2.8mm), {
    caption(L("paymentDetails"))
    typed(data.paymentDetails, labels: true, fill: body-ink, gap: 0.45em)
  })
}
#let start-part = if data.terms != none or data.notes != none {
  section(L("terms"), data.terms)
  section(L("notes"), data.notes)
}

#let sig = data.signature
#let signing-line = line(length: 100%, stroke: 0.5pt + luma(170))
#let has-marks = (sig.signature != none and data.images.at(sig.signature, default: none) != none) or (sig.stamp != none and data.images.at(sig.stamp, default: none) != none)
#let sign-h = if has-marks { 18mm } else { 10mm }
// "For <English name> / عن <الاسم العربي>": the business's language first, each name in its own
// isolate (a name in one language only is used for both); one under the other when they are long.
#let for-business = layout(size => {
  let f = L("signature.for")
  let name-en = if lh.nameEn != none { lh.nameEn } else { lh.nameAr }
  let name-ar = if lh.nameAr != none { lh.nameAr } else { lh.nameEn }
  if name-en != none {
    // The style is on the text itself, so the line is measured as it prints (bold, 8.4 pt).
    let strong = (weight: "bold", size: 8.4pt)
    let one-en = box(text(lang: "en", dir: ltr, ..strong, f.en.replace("{{name}}", fsi(name-en.text))))
    let one-ar = box(text(lang: "ar", dir: rtl, ..strong, f.ar.replace("{{name}}", fsi(name-ar.text))))
    let parts = if rtl-doc { (one-ar, one-en) } else { (one-en, one-ar) }
    set text(..strong)
    let line-one = text(..strong)[#parts.at(0) #text(fill: muted)[/] #parts.at(1)]
    if measure(line-one).width <= size.width {
      align(ds, line-one)
    } else {
      // Each as a paragraph of its own (a very long name wraps inside the column).
      let para(n, lang, label) = align(ds, text(lang: lang, dir: if lang == "ar" { rtl } else { ltr },
        label.replace("{{name}}", fsi(n.text))))
      let both = if rtl-doc { (para(name-ar, "ar", f.ar), para(name-en, "en", f.en)) } else {
        (para(name-en, "en", f.en), para(name-ar, "ar", f.ar))
      }
      stack(dir: ttb, spacing: 1.4mm, ..both)
    }
  }
})
#let marks = {
  if sig.stamp != none and data.images.at(sig.stamp, default: none) != none {
    place(ds + horizon, dx: if rtl-doc { -36mm } else { 36mm }, dy: 0.5mm, rotate(-8deg, img(sig.stamp, height: 20mm, width: 20mm, fit: "contain")))
  }
  if sig.signature != none and data.images.at(sig.signature, default: none) != none {
    place(ds + bottom, dy: -0.6mm, img(sig.signature, height: 14mm, width: 42mm, fit: "contain"))
  }
}
#let sign-box(label, body, name, foot) = block(width: 100%, {
  label
  v(0.6mm)
  box(width: 100%, height: sign-h, body)
  signing-line
  v(0.6mm)
  if name != none { block(below: 1.2mm, name) }
  align(ds, text(fill: muted, size: 7.2pt)[#bi(foot)])
})
// The two signing lines on one level, however many lines the business's names take above them.
#let signatures = block(breakable: false, grid(
  columns: (1fr, 1fr),
  column-gutter: 16mm,
  align: bottom,
  sign-box(for-business, marks,
    if sig.signatory != none { typed(sig.signatory, weight: "bold", gap: 0pt) }, L("signature.signatory")),
  if sig.acceptance {
    sign-box(align(ds, bi(L("signature.acceptance"), weight: "bold")), [],
      typed(data.customer.name, weight: "bold", gap: 0pt), L("signature.line"))
  },
))

#let side = (stages-block, payments-block, validity-block).filter(x => x != none)
#let totals-w = 90mm
#let side-w = content-w - totals-w - 7mm

#v(1.2mm)
#context {
  let side-h = if side.len() == 0 { 0pt } else { measure(block(width: side-w, side.join(v(2.4mm)))).height }
  let bank-h = if bank == none { 0pt } else { measure(block(width: side-w, bank)).height }
  let totals-h = measure(block(width: totals-w, totals-block)).height
  let gap = if side.len() == 0 { 0pt } else { 2.4mm }
  let bank-beside = bank != none and side-h + gap + bank-h <= totals-h + 4mm
  let beside = if bank-beside { side + (bank,) } else { side }
  // The totals stay with what is beside them on one page, unless that is taller than a page (ten long
  // payment stages): then it may break, never run off the page.
  let frame = page-frame()
  let fits = calc.max(side-h, totals-h) <= frame.body - 8mm
  block(breakable: not fits, below: 3.6mm, if beside.len() == 0 {
    align(de, block(width: totals-w, totals-block))
  } else {
    grid(columns: (1fr, totals-w), column-gutter: 7mm,
      align(ds, block(width: 100%, beside.join(v(2.4mm)))), totals-block)
  })
  let bank-row = if bank-beside { none } else { bank }
  let terms-row = if start-part != none and bank-row != none {
    grid(columns: (1.25fr, 1fr), column-gutter: 8mm, start-part, bank-row)
  } else if start-part != none { start-part } else if bank-row != none {
    align(de, block(width: totals-w, bank-row))
  }
  // Kept whole only when it fits on a page (measured): else the terms break and only the signatures
  // stay together.
  let closing = {
    terms-row
    v(2.6mm)
    signatures
  }
  if terms-row != none and measure(block(width: content-w, closing)).height <= frame.body - 4mm {
    block(breakable: false, closing)
  } else {
    if terms-row != none { terms-row; v(2.6mm) }
    signatures
  }
}
