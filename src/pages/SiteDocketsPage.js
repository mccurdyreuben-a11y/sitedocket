import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { jsPDF } from 'jspdf';
import { LogoutButton } from '../components/LogoutButton';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabaseClient';

const STATUS_FILTERS = [
  { id: 'submitted', label: 'Pending' },
  { id: 'approved', label: 'Approved' },
  { id: 'flagged', label: 'Flagged' },
  { id: 'all', label: 'All' },
];

const STATUS_BADGE = {
  submitted: 'bg-amber-700/40 text-amber-200',
  approved: 'bg-emerald-700/40 text-emerald-200',
  flagged: 'bg-orange-700/40 text-orange-200',
};

// Supabase Storage bucket that holds approved docket PDFs.
// Must exist and have public-read access for the returned URL to work.
const PDF_BUCKET = 'Dockets';

const PDF_MARGIN = 15; // mm
const PDF_FOOTER_HEIGHT = 22; // mm reserved for the disclaimer
const PDF_DISCLAIMER =
  'This document is an operational site record only. It does not constitute a contractual claim, legal certification, or formal notice of any kind. Accuracy of records is the sole responsibility of the parties involved.';

function formatDateTime(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
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
  if (value === null || value === undefined) return '0h';
  const n = Number(value);
  if (!Number.isFinite(n)) return `${value}h`;
  return `${n.toFixed(n % 1 === 0 ? 0 : 2)}h`;
}

function formatHoursLong(value) {
  if (value === null || value === undefined || value === '') return '\u2014';
  const n = Number(value);
  if (!Number.isFinite(n)) return `${value}`;
  return `${n.toFixed(n % 1 === 0 ? 0 : 2)} h`;
}

function getErrorMessage(err, fallback) {
  if (!err) return fallback;
  if (typeof err === 'string') return err;
  if (typeof err.message === 'string' && err.message.trim()) return err.message;
  if (typeof err.details === 'string' && err.details.trim()) return err.details;
  return fallback;
}

// Fetch any URL (or pass-through data URL) and resolve to a data URL so
// jsPDF can embed it. Returns null when the image cannot be loaded so
// PDF generation never hard-fails on a missing photo.
async function fetchAsDataUrl(url) {
  if (!url) return null;
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
    console.warn('[SiteDocketsPage] could not fetch image for PDF', url, err);
    return null;
  }
}

function imageFormatFromDataUrl(dataUrl) {
  const m = /^data:image\/([a-zA-Z0-9.+-]+);base64,/i.exec(dataUrl || '');
  const fmt = (m?.[1] || 'PNG').toUpperCase();
  return fmt === 'JPG' ? 'JPEG' : fmt;
}

function ensureRoom(doc, neededMm, cursor) {
  const pageHeight = doc.internal.pageSize.getHeight();
  if (cursor + neededMm > pageHeight - PDF_FOOTER_HEIGHT) {
    doc.addPage();
    return PDF_MARGIN + 5;
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
  doc.text(title, PDF_MARGIN, y);
  doc.setDrawColor(226, 232, 240);
  doc.setLineWidth(0.4);
  doc.line(PDF_MARGIN, y + 1.5, pageW - PDF_MARGIN, y + 1.5);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(15, 23, 42);
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
  return drawWrappedText(doc, value ?? '\u2014', x, y + 5, maxWidth);
}

function drawFooterOnAllPages(doc) {
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const totalPages = doc.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    doc.setDrawColor(226, 232, 240);
    doc.setLineWidth(0.3);
    doc.line(PDF_MARGIN, pageH - 18, pageW - PDF_MARGIN, pageH - 18);
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    const lines = doc.splitTextToSize(PDF_DISCLAIMER, pageW - 2 * PDF_MARGIN);
    lines.forEach((line, idx) => {
      doc.text(line, PDF_MARGIN, pageH - 14 + idx * 3.5);
    });
    doc.setFont('helvetica', 'normal');
    doc.text(`Page ${i} of ${totalPages}`, pageW - PDF_MARGIN, pageH - 6, {
      align: 'right',
    });
  }
}

// Build the docket PDF as a Blob. Pure-ish: takes already-loaded data and
// returns a Blob, so it can be tested and reused without re-hitting Supabase.
async function buildDocketPdfBlob({ docket, site, delays, approver }) {
  if (!docket) throw new Error('buildDocketPdfBlob: docket is required.');

  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const contentW = pageW - 2 * PDF_MARGIN;
  let y = PDF_MARGIN + 5;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.setTextColor(16, 122, 87);
  doc.text('SiteDocket', PDF_MARGIN, y);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(71, 85, 105);
  doc.text(
    formatLongDate(docket.work_date || docket.created_at),
    pageW - PDF_MARGIN,
    y,
    { align: 'right' }
  );

  y += 7;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(15, 23, 42);
  doc.text(site?.name || 'Site', PDF_MARGIN, y);

  if (site?.address) {
    y += 5;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(100, 116, 139);
    drawWrappedText(doc, site.address, PDF_MARGIN, y, contentW);
  }

  y += 8;
  doc.setDrawColor(16, 122, 87);
  doc.setLineWidth(0.8);
  doc.line(PDF_MARGIN, y, pageW - PDF_MARGIN, y);
  y += 8;

  // Section 1: Work Record
  y = drawSectionHeader(doc, '1. Work Record', y);

  const sub = docket.subcontractor || {};
  const colW = (contentW - 8) / 2;
  const col2X = PDF_MARGIN + colW + 8;

  const leftY1 = drawKeyValue(doc, 'Subcontractor', sub.name || '\u2014', PDF_MARGIN, y, colW);
  const rightY1 = drawKeyValue(doc, 'Company', sub.company_name || '\u2014', col2X, y, colW);
  y = Math.max(leftY1, rightY1) + 4;

  const leftY2 = drawKeyValue(doc, 'Trade', docket.trade_type || '\u2014', PDF_MARGIN, y, colW);
  const rightY2 = drawKeyValue(
    doc,
    'Hours on Site',
    formatHoursLong(docket.hours_on_site),
    col2X,
    y,
    colW
  );
  y = Math.max(leftY2, rightY2) + 4;

  y = drawKeyValue(
    doc,
    'Work Description',
    docket.work_description || '\u2014',
    PDF_MARGIN,
    y,
    contentW
  );
  y += 6;

  // Section 2: Delays (only when has_delay is true)
  if (docket.has_delay) {
    y = ensureRoom(doc, 18, y);
    y = drawSectionHeader(doc, '2. Delays', y);

    const delayRows = Array.isArray(delays) ? delays : [];
    if (delayRows.length === 0) {
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(10);
      doc.setTextColor(100, 116, 139);
      doc.text('Delay reported, but no detail rows are on file.', PDF_MARGIN, y);
      y += 8;
    } else {
      for (let i = 0; i < delayRows.length; i++) {
        const d = delayRows[i];
        y = ensureRoom(doc, 30, y);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        doc.setTextColor(159, 18, 57);
        doc.text(`Delay ${i + 1} \u00b7 ${d.category || 'Uncategorised'}`, PDF_MARGIN, y);
        y += 5;

        if (d.created_at) {
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(9);
          doc.setTextColor(100, 116, 139);
          doc.text(`Logged ${formatDateTime(d.created_at)}`, PDF_MARGIN, y);
          y += 5;
        }

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        doc.setTextColor(15, 23, 42);
        y = drawWrappedText(doc, d.description || '\u2014', PDF_MARGIN, y, contentW);
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
              doc.rect(PDF_MARGIN, y, imgW, imgH);
              doc.addImage(
                dataUrl,
                imageFormatFromDataUrl(dataUrl),
                PDF_MARGIN + 0.5,
                y + 0.5,
                imgW - 1,
                imgH - 1,
                undefined,
                'FAST'
              );
              y += imgH + 4;
            } catch (err) {
              console.warn('[SiteDocketsPage] could not embed delay photo', err);
            }
          }
        }
        y += 4;
      }
    }
  }

  // Section 3 (or 2 if no delays): Signature
  const sigSectionTitle = docket.has_delay ? '3. Signature' : '2. Signature';
  y = ensureRoom(doc, 60, y);
  y = drawSectionHeader(doc, sigSectionTitle, y);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(100, 116, 139);
  doc.text('SUBCONTRACTOR SIGNATURE', PDF_MARGIN, y);
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
      doc.rect(PDF_MARGIN, y, sigW, sigH);
      doc.addImage(
        signatureDataUrl,
        imageFormatFromDataUrl(signatureDataUrl),
        PDF_MARGIN + 1,
        y + 1,
        sigW - 2,
        sigH - 2
      );
      y += sigH + 3;
    } catch (err) {
      console.warn('[SiteDocketsPage] could not embed signature', err);
      y += 5;
    }
  } else {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(10);
    doc.setTextColor(100, 116, 139);
    doc.text('(no signature on file)', PDF_MARGIN, y);
    y += 8;
  }

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(15, 23, 42);
  doc.text(sub.name || '\u2014', PDF_MARGIN, y);
  if (sub.company_name) {
    y += 4.5;
    doc.setFontSize(9);
    doc.setTextColor(100, 116, 139);
    doc.text(sub.company_name, PDF_MARGIN, y);
  }
  y += 10;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(100, 116, 139);
  doc.text('APPROVED BY', PDF_MARGIN, y);
  y += 5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(15, 23, 42);
  doc.text(approver?.name || '\u2014', PDF_MARGIN, y);
  if (approver?.company_name) {
    y += 4.5;
    doc.setFontSize(9);
    doc.setTextColor(100, 116, 139);
    doc.text(approver.company_name, PDF_MARGIN, y);
  }
  y += 5;
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  doc.text(`Approved ${formatDateTime(docket.reviewed_at)}`, PDF_MARGIN, y);

  drawFooterOnAllPages(doc);

  return doc.output('blob');
}

// Generate the docket PDF, upload it to the `Dockets` bucket, and persist
// the resulting public URL on `dockets.pdf_url`. Returns the public URL.
async function generateAndUploadDocketPdf({ docket, site, delays, approver }) {
  if (!docket?.id) throw new Error('generateAndUploadDocketPdf: docket.id missing.');

  const blob = await buildDocketPdfBlob({ docket, site, delays, approver });

  // Scope the storage path by auth user so RLS can restrict writes to the
  // approving contractor's own folder.
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


export function SiteDocketsPage() {
  const { siteId } = useParams();
  const { profile } = useAuth();

  const [site, setSite] = useState(null);
  const [siteError, setSiteError] = useState('');
  const [loadingSite, setLoadingSite] = useState(true);

  const [dockets, setDockets] = useState([]);
  const [loadingDockets, setLoadingDockets] = useState(true);
  const [listError, setListError] = useState('');

  const [filter, setFilter] = useState('submitted');

  // Per-docket transient UI state.
  const [pendingAction, setPendingAction] = useState({}); // { [docketId]: 'approve' | 'flag' }
  const [actionError, setActionError] = useState({});     // { [docketId]: string }
  const [flagDraft, setFlagDraft] = useState({});         // { [docketId]: { open: boolean, note: string } }
  const [pdfState, setPdfState] = useState({});           // { [docketId]: 'pending' | 'error' }
  const [previewSig, setPreviewSig] = useState(null);     // data URL string
  const [previewPhoto, setPreviewPhoto] = useState(null); // url string

  const fetchSite = useCallback(async () => {
    if (!siteId) return;
    setLoadingSite(true);
    setSiteError('');
    const { data, error } = await supabase
      .from('sites')
      .select('id, name, address, contractor_id')
      .eq('id', siteId)
      .maybeSingle();

    if (error) {
      setSiteError(error.message || 'Could not load site.');
      setLoadingSite(false);
      return;
    }
    if (!data) {
      setSiteError('Site not found.');
      setLoadingSite(false);
      return;
    }
    if (profile?.id && data.contractor_id !== profile.id) {
      setSiteError('You are not the owner of this site.');
      setLoadingSite(false);
      return;
    }
    setSite(data);
    setLoadingSite(false);
  }, [siteId, profile?.id]);

  const fetchDockets = useCallback(async () => {
    if (!siteId) return;
    setLoadingDockets(true);
    setListError('');

    // Embedding the related users row works because
    // dockets.subcontractor_id is a foreign key to public.users(id).
    // Delay details live in public.delays (FK delays.docket_id ->
    // dockets.id) and are pulled in via the relational select.
    const { data, error } = await supabase
      .from('dockets')
      .select(
        `id, site_id, subcontractor_id, trade_type, work_description,
         hours_on_site, has_delay, signature_data_url, status, flag_note,
         reviewed_at, reviewed_by, work_date, created_at, pdf_url,
         subcontractor:users!dockets_sub_id_fkey(id, name, company_name),
         delays(category, description, photo_url, created_at)`
      )
      .eq('site_id', siteId)
      .order('created_at', { ascending: false });

    if (error) {
      setListError(error.message || 'Could not load dockets.');
      setDockets([]);
      setLoadingDockets(false);
      return;
    }
    setDockets(data || []);
    setLoadingDockets(false);
  }, [siteId]);

  useEffect(() => {
    void fetchSite();
  }, [fetchSite]);

  useEffect(() => {
    void fetchDockets();
  }, [fetchDockets]);

  const counts = useMemo(() => {
    const acc = { submitted: 0, approved: 0, flagged: 0, all: dockets.length };
    dockets.forEach((d) => {
      const k = d.status || 'submitted';
      if (acc[k] !== undefined) acc[k] += 1;
    });
    return acc;
  }, [dockets]);

  const filteredDockets = useMemo(() => {
    if (filter === 'all') return dockets;
    return dockets.filter((d) => (d.status || 'submitted') === filter);
  }, [dockets, filter]);

  const setActionErrorFor = useCallback((docketId, message) => {
    setActionError((prev) => ({ ...prev, [docketId]: message }));
  }, []);

  const clearActionErrorFor = useCallback((docketId) => {
    setActionError((prev) => {
      if (!(docketId in prev)) return prev;
      const next = { ...prev };
      delete next[docketId];
      return next;
    });
  }, []);

  const updateLocalDocket = useCallback((docketId, patch) => {
    setDockets((prev) => prev.map((d) => (d.id === docketId ? { ...d, ...patch } : d)));
  }, []);

  const setPdfStateFor = useCallback((docketId, state) => {
    setPdfState((prev) => {
      if (state == null) {
        if (!(docketId in prev)) return prev;
        const next = { ...prev };
        delete next[docketId];
        return next;
      }
      return { ...prev, [docketId]: state };
    });
  }, []);

  const handleApprove = useCallback(
    async (docket) => {
      clearActionErrorFor(docket.id);
      setPendingAction((prev) => ({ ...prev, [docket.id]: 'approve' }));

      const previousSnapshot = {
        status: docket.status,
        flag_note: docket.flag_note,
        reviewed_at: docket.reviewed_at,
        reviewed_by: docket.reviewed_by,
      };
      const reviewedAt = new Date().toISOString();
      const approvedPatch = {
        status: 'approved',
        flag_note: null,
        reviewed_at: reviewedAt,
        reviewed_by: profile?.id || null,
      };

      // Optimistic update so the UI feels instant.
      updateLocalDocket(docket.id, approvedPatch);

      try {
        const { error } = await supabase
          .from('dockets')
          .update(approvedPatch)
          .eq('id', docket.id);

        if (error) throw error;
      } catch (err) {
        console.error('[SiteDocketsPage] approve failed', err);
        updateLocalDocket(docket.id, previousSnapshot);
        setActionErrorFor(docket.id, getErrorMessage(err, 'Could not approve docket.'));
        setPendingAction((prev) => {
          const next = { ...prev };
          delete next[docket.id];
          return next;
        });
        return;
      }

      setPendingAction((prev) => {
        const next = { ...prev };
        delete next[docket.id];
        return next;
      });

      // Approval persisted — now build and upload the PDF. We deliberately
      // don't roll back the approval if PDF generation fails; the approval
      // itself is the source of truth and the PDF can be regenerated.
      setPdfStateFor(docket.id, 'pending');
      try {
        const approvedDocket = {
          ...docket,
          ...approvedPatch,
        };
        const pdfUrl = await generateAndUploadDocketPdf({
          docket: approvedDocket,
          site,
          delays: Array.isArray(docket.delays) ? docket.delays : [],
          approver: profile,
        });
        updateLocalDocket(docket.id, { pdf_url: pdfUrl });
        setPdfStateFor(docket.id, null);
      } catch (err) {
        console.error('[SiteDocketsPage] PDF generation failed', err);
        setPdfStateFor(docket.id, 'error');
        setActionErrorFor(
          docket.id,
          getErrorMessage(err, 'Approved, but PDF generation failed.')
        );
      }
    },
    [
      clearActionErrorFor,
      profile,
      setActionErrorFor,
      setPdfStateFor,
      site,
      updateLocalDocket,
    ]
  );

  const openFlagForm = useCallback(
    (docket) => {
      clearActionErrorFor(docket.id);
      setFlagDraft((prev) => ({
        ...prev,
        [docket.id]: { open: true, note: docket.flag_note || '' },
      }));
    },
    [clearActionErrorFor]
  );

  const closeFlagForm = useCallback((docketId) => {
    setFlagDraft((prev) => {
      if (!(docketId in prev)) return prev;
      const next = { ...prev };
      delete next[docketId];
      return next;
    });
  }, []);

  const updateFlagNote = useCallback((docketId, note) => {
    setFlagDraft((prev) => ({
      ...prev,
      [docketId]: { open: true, note },
    }));
  }, []);

  const handleSubmitFlag = useCallback(
    async (docket) => {
      const draft = flagDraft[docket.id];
      const note = (draft?.note || '').trim();
      if (!note) {
        setActionErrorFor(docket.id, 'Add a short note explaining the issue.');
        return;
      }

      clearActionErrorFor(docket.id);
      setPendingAction((prev) => ({ ...prev, [docket.id]: 'flag' }));

      const previousSnapshot = {
        status: docket.status,
        flag_note: docket.flag_note,
        reviewed_at: docket.reviewed_at,
        reviewed_by: docket.reviewed_by,
      };
      const reviewedAt = new Date().toISOString();

      updateLocalDocket(docket.id, {
        status: 'flagged',
        flag_note: note,
        reviewed_at: reviewedAt,
        reviewed_by: profile?.id || null,
      });

      try {
        const { error } = await supabase
          .from('dockets')
          .update({
            status: 'flagged',
            flag_note: note,
            reviewed_at: reviewedAt,
            reviewed_by: profile?.id || null,
          })
          .eq('id', docket.id);

        if (error) throw error;
        closeFlagForm(docket.id);
      } catch (err) {
        console.error('[SiteDocketsPage] flag failed', err);
        updateLocalDocket(docket.id, previousSnapshot);
        setActionErrorFor(docket.id, getErrorMessage(err, 'Could not flag docket.'));
      } finally {
        setPendingAction((prev) => {
          const next = { ...prev };
          delete next[docket.id];
          return next;
        });
      }
    },
    [clearActionErrorFor, closeFlagForm, flagDraft, profile?.id, setActionErrorFor, updateLocalDocket]
  );

  if (loadingSite) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950">
        <div className="h-10 w-10 animate-spin rounded-full border-2 border-slate-600 border-t-emerald-400" />
      </div>
    );
  }

  if (siteError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 px-4">
        <div className="w-full max-w-lg rounded-xl border border-rose-900/50 bg-rose-950/30 p-6 text-center">
          <p className="text-lg font-semibold text-rose-200">Could not load site</p>
          <p className="mt-2 text-sm text-rose-100/80">{siteError}</p>
          <Link
            to="/dashboard"
            className="mt-5 inline-block rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500"
          >
            Back to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950">
      <header className="flex items-center justify-between border-b border-slate-800 px-4 py-4 sm:px-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
            <Link to="/dashboard" className="hover:text-emerald-400">
              Dashboard
            </Link>
            <span>/</span>
            <span className="truncate text-slate-300">{site?.name}</span>
          </div>
          <h1 className="mt-1 truncate text-lg font-semibold text-white">Dockets</h1>
          <p className="truncate text-sm text-slate-400">{site?.address}</p>
        </div>
        <LogoutButton />
      </header>

      <main className="mx-auto w-full max-w-4xl space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap gap-2">
          {STATUS_FILTERS.map((opt) => {
            const active = filter === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => setFilter(opt.id)}
                className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition ${
                  active
                    ? 'bg-emerald-600 text-white'
                    : 'border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800'
                }`}
              >
                {opt.label}
                <span
                  className={`ml-2 rounded-full px-1.5 py-0.5 text-xs ${
                    active ? 'bg-emerald-800/60 text-emerald-100' : 'bg-slate-800 text-slate-400'
                  }`}
                >
                  {counts[opt.id] ?? 0}
                </span>
              </button>
            );
          })}
        </div>

        {listError ? (
          <div className="rounded-lg border border-rose-900/50 bg-rose-950/50 px-4 py-3 text-sm text-rose-200">
            {listError}
          </div>
        ) : null}

        {loadingDockets ? (
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => (
              <div
                key={i}
                className="h-40 animate-pulse rounded-xl border border-slate-800 bg-slate-900/50"
              />
            ))}
          </div>
        ) : null}

        {!loadingDockets && filteredDockets.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/40 px-6 py-12 text-center">
            <p className="text-base font-medium text-slate-200">No dockets to review</p>
            <p className="mt-1 text-sm text-slate-400">
              {filter === 'all'
                ? 'Subcontractors haven\u2019t submitted any dockets for this site yet.'
                : `No dockets currently in \u201C${
                    STATUS_FILTERS.find((f) => f.id === filter)?.label
                  }\u201D.`}
            </p>
          </div>
        ) : null}

        <ul className="space-y-3">
          {filteredDockets.map((docket) => {
            const status = docket.status || 'submitted';
            const sub = docket.subcontractor || {};
            const subName = sub.name || 'Unknown subcontractor';
            const subCompany = sub.company_name;
            const isPending = status === 'submitted';
            const action = pendingAction[docket.id];
            const draft = flagDraft[docket.id];
            const errMsg = actionError[docket.id];
            const pdfStatus = pdfState[docket.id];

            return (
              <li
                key={docket.id}
                className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 shadow-lg shadow-black/20"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-base font-semibold text-white">{subName}</h3>
                    {subCompany ? (
                      <p className="text-sm text-slate-400">{subCompany}</p>
                    ) : null}
                  </div>
                  <div className="flex flex-col items-end gap-1 text-right">
                    <span
                      className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                        STATUS_BADGE[status] || 'bg-slate-700 text-slate-200'
                      }`}
                    >
                      {status === 'submitted'
                        ? 'Pending'
                        : status.charAt(0).toUpperCase() + status.slice(1)}
                    </span>
                    <span className="text-xs text-slate-400">
                      {formatDateTime(docket.created_at)}
                    </span>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-2 text-xs font-medium">
                  <span className="rounded-full bg-indigo-700/40 px-2.5 py-1 text-indigo-200">
                    {docket.trade_type}
                  </span>
                  <span className="rounded-full bg-slate-800 px-2.5 py-1 text-slate-300">
                    {formatHours(docket.hours_on_site)} on site
                  </span>
                  {docket.has_delay ? (
                    <span className="rounded-full bg-rose-700/40 px-2.5 py-1 text-rose-200">
                      Delay reported
                    </span>
                  ) : null}
                </div>

                <div className="mt-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    Work Description
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-slate-200">
                    {docket.work_description}
                  </p>
                </div>

                {docket.has_delay && Array.isArray(docket.delays) && docket.delays.length > 0
                  ? docket.delays.map((delay, idx) => (
                      <div
                        key={`${docket.id}-delay-${idx}`}
                        className="mt-4 rounded-lg border border-rose-900/40 bg-rose-950/20 p-3"
                      >
                        <p className="text-xs font-semibold uppercase tracking-wide text-rose-300">
                          Delay
                          {delay.category ? ` \u00b7 ${delay.category}` : ''}
                        </p>
                        {delay.description ? (
                          <p className="mt-1 whitespace-pre-wrap text-sm text-rose-100/90">
                            {delay.description}
                          </p>
                        ) : null}
                        {delay.photo_url ? (
                          <button
                            type="button"
                            onClick={() => setPreviewPhoto(delay.photo_url)}
                            className="mt-3 block overflow-hidden rounded-md border border-rose-900/40"
                          >
                            <img
                              src={delay.photo_url}
                              alt="Delay evidence"
                              className="h-36 w-full object-cover"
                            />
                          </button>
                        ) : null}
                      </div>
                    ))
                  : null}

                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-2">
                    <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                      Signature
                    </p>
                    {docket.signature_data_url ? (
                      <button
                        type="button"
                        onClick={() => setPreviewSig(docket.signature_data_url)}
                        className="overflow-hidden rounded-md border border-slate-700 bg-white"
                      >
                        <img
                          src={docket.signature_data_url}
                          alt="Subcontractor signature"
                          className="h-12 w-32 object-contain"
                        />
                      </button>
                    ) : (
                      <span className="text-xs text-slate-500">No signature</span>
                    )}
                  </div>
                </div>

                {status !== 'submitted' && docket.reviewed_at ? (
                  <div
                    className={`mt-4 rounded-lg border px-3 py-2 text-xs ${
                      status === 'approved'
                        ? 'border-emerald-900/40 bg-emerald-950/30 text-emerald-200'
                        : 'border-orange-900/40 bg-orange-950/30 text-orange-200'
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-medium">
                        {status === 'approved' ? 'Approved' : 'Flagged'} on{' '}
                        {formatDateTime(docket.reviewed_at)}
                      </p>
                      {status === 'approved' ? (
                        <div className="flex items-center gap-2">
                          {pdfStatus === 'pending' ? (
                            <span className="inline-flex items-center gap-1.5 text-emerald-200/80">
                              <span className="h-2.5 w-2.5 animate-spin rounded-full border border-emerald-300 border-t-transparent" />
                              Generating PDF…
                            </span>
                          ) : null}
                          {docket.pdf_url ? (
                            <a
                              href={docket.pdf_url}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="inline-flex items-center gap-1 rounded-md border border-emerald-700/60 bg-emerald-900/40 px-2.5 py-1 text-xs font-semibold text-emerald-100 hover:bg-emerald-800/50"
                            >
                              View PDF
                            </a>
                          ) : null}
                          {pdfStatus === 'error' && !docket.pdf_url ? (
                            <span className="text-rose-300">PDF failed</span>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                    {status === 'flagged' && docket.flag_note ? (
                      <p className="mt-1 whitespace-pre-wrap text-orange-100/90">
                        {`\u201C${docket.flag_note}\u201D`}
                      </p>
                    ) : null}
                  </div>
                ) : null}

                {errMsg ? (
                  <div className="mt-3 rounded-lg border border-rose-900/50 bg-rose-950/40 px-3 py-2 text-xs text-rose-200">
                    {errMsg}
                  </div>
                ) : null}

                {isPending && draft?.open ? (
                  <div className="mt-4 rounded-lg border border-orange-900/40 bg-orange-950/20 p-3">
                    <label
                      htmlFor={`flag-note-${docket.id}`}
                      className="block text-xs font-medium text-orange-200"
                    >
                      {'What\u2019s the issue?'}
                    </label>
                    <textarea
                      id={`flag-note-${docket.id}`}
                      rows={3}
                      autoFocus
                      value={draft.note}
                      onChange={(e) => updateFlagNote(docket.id, e.target.value)}
                      placeholder={'e.g. Hours don\u2019t match site sign-in log'}
                      className="mt-2 w-full rounded-md border border-orange-900/40 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
                    />
                    <div className="mt-3 flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => closeFlagForm(docket.id)}
                        disabled={action === 'flag'}
                        className="rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-50"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSubmitFlag(docket)}
                        disabled={action === 'flag'}
                        className="rounded-md bg-orange-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-400 disabled:opacity-50"
                      >
                        {action === 'flag' ? 'Saving…' : 'Submit Flag'}
                      </button>
                    </div>
                  </div>
                ) : null}

                {isPending && !draft?.open ? (
                  <div className="mt-5 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => handleApprove(docket)}
                      disabled={Boolean(action)}
                      className="flex-1 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {action === 'approve' ? 'Approving…' : 'Approve'}
                    </button>
                    <button
                      type="button"
                      onClick={() => openFlagForm(docket)}
                      disabled={Boolean(action)}
                      className="flex-1 rounded-lg bg-orange-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-orange-400 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Flag Issue
                    </button>
                  </div>
                ) : null}

                {!isPending ? (
                  <div className="mt-4 flex justify-end">
                    <button
                      type="button"
                      onClick={() => openFlagForm(docket)}
                      className="text-xs font-medium text-slate-400 underline-offset-2 hover:text-orange-300 hover:underline"
                    >
                      {status === 'flagged' ? 'Edit flag note' : 'Re-open & flag'}
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </main>

      {previewSig ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setPreviewSig(null)}
        >
          <div className="rounded-xl bg-white p-4 shadow-2xl">
            <img src={previewSig} alt="Signature preview" className="max-h-[70vh] max-w-full" />
          </div>
        </div>
      ) : null}

      {previewPhoto ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setPreviewPhoto(null)}
        >
          <img
            src={previewPhoto}
            alt="Delay evidence preview"
            className="max-h-[85vh] max-w-full rounded-lg shadow-2xl"
          />
        </div>
      ) : null}
    </div>
  );
}
