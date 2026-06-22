import { jsPDF } from 'jspdf';
import { supabase } from './supabaseClient';

// Exact disclaimer text required at the foot of every page.
const DISCLAIMER =
  'This document is an operational site record only. It does not constitute a contractual claim, legal certification, or formal notice of any kind. Accuracy of records is the sole responsibility of the parties involved.';

const PAGE_MARGIN = 15; // mm
const FOOTER_HEIGHT = 25; // mm reserved at the bottom for the disclaimer

// Bucket dedicated to approved-docket PDFs. Must exist in Supabase Storage
// (see README/schema notes) with public read + authenticated upload policy.
const PDF_BUCKET = 'docket-pdfs';

function formatDateTime(iso) {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return String(iso);
  }
}

function formatLongDate(iso) {
  const d = iso ? new Date(iso) : new Date();
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }).format(d);
  } catch {
    return d.toDateString();
  }
}

function formatHours(value) {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return `${value}`;
  return `${n.toFixed(n % 1 === 0 ? 0 : 2)} h`;
}

// Pull a remote image (e.g. a public Supabase Storage URL) into a data URL
// so jsPDF can embed it. Returns null if the fetch fails; the caller falls
// back to omitting the image so PDF generation never blocks on a missing
// asset.
async function fetchAsDataUrl(url) {
  if (!url) return null;
  // Already a data URL (signature pad output) — pass through.
  if (typeof url === 'string' && url.startsWith('data:')) return url;
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch (err) {
    console.warn('[docketPdf] could not fetch image', url, err);
    return null;
  }
}

function imageFormatFromDataUrl(dataUrl) {
  const m = /^data:image\/([a-zA-Z0-9.+-]+);base64,/i.exec(dataUrl || '');
  const fmt = (m?.[1] || 'PNG').toUpperCase();
  // jsPDF expects "JPEG" rather than "JPG".
  if (fmt === 'JPG') return 'JPEG';
  return fmt;
}

function ensureRoom(doc, neededMm, cursor) {
  const pageHeight = doc.internal.pageSize.getHeight();
  if (cursor + neededMm > pageHeight - FOOTER_HEIGHT) {
    doc.addPage();
    return PAGE_MARGIN + 5;
  }
  return cursor;
}

function drawWrappedText(doc, text, x, y, maxWidth, lineHeight = 5) {
  const lines = doc.splitTextToSize(String(text ?? ''), maxWidth);
  lines.forEach((line, i) => {
    doc.text(line, x, y + i * lineHeight);
  });
  return y + lines.length * lineHeight;
}

function drawSectionHeader(doc, title, y) {
  const pageW = doc.internal.pageSize.getWidth();
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(30, 41, 59);
  doc.text(title, PAGE_MARGIN, y);
  doc.setDrawColor(226, 232, 240);
  doc.setLineWidth(0.4);
  doc.line(PAGE_MARGIN, y + 1.5, pageW - PAGE_MARGIN, y + 1.5);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(30, 41, 59);
  return y + 8;
}

function drawKeyValue(doc, label, value, x, y, maxWidth) {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(100, 116, 139);
  doc.text(String(label).toUpperCase(), x, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(15, 23, 42);
  return drawWrappedText(doc, value ?? '—', x, y + 5, maxWidth);
}

function drawFooterOnAllPages(doc) {
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const totalPages = doc.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    doc.setDrawColor(226, 232, 240);
    doc.setLineWidth(0.3);
    doc.line(PAGE_MARGIN, pageH - 22, pageW - PAGE_MARGIN, pageH - 22);
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    const lines = doc.splitTextToSize(DISCLAIMER, pageW - 2 * PAGE_MARGIN);
    lines.forEach((line, idx) => {
      doc.text(line, PAGE_MARGIN, pageH - 18 + idx * 3.5);
    });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    doc.text(`Page ${i} of ${totalPages}`, pageW - PAGE_MARGIN, pageH - 6, {
      align: 'right',
    });
  }
}

/**
 * Build a jsPDF Blob for an approved docket.
 *
 * Inputs are intentionally explicit (rather than re-fetching from Supabase)
 * so this function is easy to call from anywhere with already-loaded data
 * and easy to unit test.
 */
export async function buildDocketPdfBlob({ docket, site, delays, approver }) {
  if (!docket) throw new Error('buildDocketPdfBlob: docket is required.');

  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const contentW = pageW - 2 * PAGE_MARGIN;

  let y = PAGE_MARGIN + 5;

  // ── Header ──────────────────────────────────────────────────────────────
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.setTextColor(16, 122, 87);
  doc.text('SiteDocket', PAGE_MARGIN, y);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(71, 85, 105);
  doc.text(formatLongDate(docket.work_date || docket.created_at), pageW - PAGE_MARGIN, y, {
    align: 'right',
  });

  y += 7;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(15, 23, 42);
  doc.text(site?.name || 'Site', PAGE_MARGIN, y);

  if (site?.address) {
    y += 5;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(100, 116, 139);
    drawWrappedText(doc, site.address, PAGE_MARGIN, y, contentW);
  }

  y += 8;
  doc.setDrawColor(16, 122, 87);
  doc.setLineWidth(0.8);
  doc.line(PAGE_MARGIN, y, pageW - PAGE_MARGIN, y);
  y += 8;

  // ── Section 1: Work Record ──────────────────────────────────────────────
  y = drawSectionHeader(doc, '1. Work Record', y);

  const sub = docket.subcontractor || {};
  const colW = (contentW - 8) / 2;
  const col2X = PAGE_MARGIN + colW + 8;

  const leftY1 = drawKeyValue(doc, 'Subcontractor', sub.name || '—', PAGE_MARGIN, y, colW);
  const rightY1 = drawKeyValue(doc, 'Company', sub.company_name || '—', col2X, y, colW);
  y = Math.max(leftY1, rightY1) + 4;

  const leftY2 = drawKeyValue(doc, 'Trade', docket.trade_type || '—', PAGE_MARGIN, y, colW);
  const rightY2 = drawKeyValue(doc, 'Hours on Site', formatHours(docket.hours_on_site), col2X, y, colW);
  y = Math.max(leftY2, rightY2) + 4;

  y = drawKeyValue(doc, 'Work Description', docket.work_description || '—', PAGE_MARGIN, y, contentW);
  y += 6;

  // ── Section 2: Delays ───────────────────────────────────────────────────
  y = ensureRoom(doc, 18, y);
  y = drawSectionHeader(doc, '2. Delays', y);

  const delayRows = Array.isArray(delays) ? delays : [];
  if (delayRows.length === 0) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(10);
    doc.setTextColor(100, 116, 139);
    doc.text('No delays were logged for this docket.', PAGE_MARGIN, y);
    y += 8;
  } else {
    for (let i = 0; i < delayRows.length; i++) {
      const d = delayRows[i];

      y = ensureRoom(doc, 30, y);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(159, 18, 57);
      doc.text(`Delay ${i + 1} · ${d.category || 'Uncategorised'}`, PAGE_MARGIN, y);
      y += 5;

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(100, 116, 139);
      doc.text(`Logged ${formatDateTime(d.created_at)}`, PAGE_MARGIN, y);
      y += 5;

      doc.setFontSize(10);
      doc.setTextColor(15, 23, 42);
      y = drawWrappedText(doc, d.description || '—', PAGE_MARGIN, y, contentW);
      y += 2;

      if (d.photo_url) {
        const dataUrl = await fetchAsDataUrl(d.photo_url);
        if (dataUrl) {
          const imgW = 70;
          const imgH = 50;
          y = ensureRoom(doc, imgH + 6, y);
          try {
            doc.setDrawColor(226, 232, 240);
            doc.setLineWidth(0.3);
            doc.rect(PAGE_MARGIN, y, imgW, imgH);
            doc.addImage(
              dataUrl,
              imageFormatFromDataUrl(dataUrl),
              PAGE_MARGIN + 0.5,
              y + 0.5,
              imgW - 1,
              imgH - 1,
              undefined,
              'FAST'
            );
            y += imgH + 4;
          } catch (err) {
            console.warn('[docketPdf] could not embed delay photo', err);
          }
        }
      }
      y += 4;
    }
  }

  // ── Section 3: Signatures ───────────────────────────────────────────────
  y = ensureRoom(doc, 60, y);
  y = drawSectionHeader(doc, '3. Signatures', y);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(100, 116, 139);
  doc.text('SUBCONTRACTOR SIGNATURE', PAGE_MARGIN, y);
  y += 4;

  const signatureDataUrl = docket.signature_data_url
    ? await fetchAsDataUrl(docket.signature_data_url)
    : null;

  if (signatureDataUrl) {
    const sigW = 80;
    const sigH = 32;
    try {
      doc.setDrawColor(203, 213, 225);
      doc.setLineWidth(0.3);
      doc.rect(PAGE_MARGIN, y, sigW, sigH);
      doc.addImage(
        signatureDataUrl,
        imageFormatFromDataUrl(signatureDataUrl),
        PAGE_MARGIN + 1,
        y + 1,
        sigW - 2,
        sigH - 2
      );
      y += sigH + 3;
    } catch (err) {
      console.warn('[docketPdf] could not embed signature', err);
      y += 5;
    }
  } else {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(10);
    doc.setTextColor(100, 116, 139);
    doc.text('(no signature on file)', PAGE_MARGIN, y);
    y += 8;
  }

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(15, 23, 42);
  doc.text(sub.name || '—', PAGE_MARGIN, y);
  if (sub.company_name) {
    y += 4.5;
    doc.setFontSize(9);
    doc.setTextColor(100, 116, 139);
    doc.text(sub.company_name, PAGE_MARGIN, y);
  }
  y += 10;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(100, 116, 139);
  doc.text('APPROVED BY', PAGE_MARGIN, y);
  y += 5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(15, 23, 42);
  doc.text(approver?.name || '—', PAGE_MARGIN, y);
  if (approver?.company_name) {
    y += 4.5;
    doc.setFontSize(9);
    doc.setTextColor(100, 116, 139);
    doc.text(approver.company_name, PAGE_MARGIN, y);
  }
  y += 5;
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  doc.text(`Approved ${formatDateTime(docket.reviewed_at)}`, PAGE_MARGIN, y);

  // ── Footer on every page ────────────────────────────────────────────────
  drawFooterOnAllPages(doc);

  return doc.output('blob');
}

/**
 * Generate a PDF for the approved docket, upload it to Supabase Storage,
 * and persist the resulting public URL on the docket row.
 *
 * Returns the final `pdf_url` so the caller can update its local state.
 */
export async function generateAndUploadDocketPdf({ docket, site, delays, approver }) {
  if (!docket?.id) throw new Error('generateAndUploadDocketPdf: docket.id missing.');

  const blob = await buildDocketPdfBlob({ docket, site, delays, approver });

  // Path layout `<auth_uid>/<docket_id>.pdf` so storage RLS can scope writes
  // to the approving contractor's own folder.
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError) throw authError;
  const uid = authData?.user?.id;
  if (!uid) throw new Error('Not authenticated.');

  const path = `${uid}/${docket.id}.pdf`;

  const { error: uploadError } = await supabase.storage
    .from(PDF_BUCKET)
    .upload(path, blob, {
      contentType: 'application/pdf',
      upsert: true,
      cacheControl: '3600',
    });
  if (uploadError) throw uploadError;

  const { data: pub } = supabase.storage.from(PDF_BUCKET).getPublicUrl(path);
  const pdfUrl = pub?.publicUrl || path;

  const { error: updateError } = await supabase
    .from('dockets')
    .update({ pdf_url: pdfUrl })
    .eq('id', docket.id);
  if (updateError) throw updateError;

  return pdfUrl;
}
