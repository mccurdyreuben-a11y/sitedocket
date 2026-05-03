import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
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

function formatHours(value) {
  if (value === null || value === undefined) return '0h';
  const n = Number(value);
  if (!Number.isFinite(n)) return `${value}h`;
  return `${n.toFixed(n % 1 === 0 ? 0 : 2)}h`;
}

function getErrorMessage(err, fallback) {
  if (!err) return fallback;
  if (typeof err === 'string') return err;
  if (typeof err.message === 'string' && err.message.trim()) return err.message;
  if (typeof err.details === 'string' && err.details.trim()) return err.details;
  return fallback;
}

/**
 * Hook for the contractor PDF generation step.
 * Replace this stub with the real call (e.g. invoke a Supabase Edge Function)
 * once that work lands.
 */
async function triggerPdfGeneration(docketId) {
  // TODO: wire up real PDF generation here.
  console.log('[SiteDocketsPage] PDF generation queued for docket', docketId);
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
    const { data, error } = await supabase
      .from('dockets')
      .select(
        `id, site_id, subcontractor_id, trade_type, work_description,
         hours_on_site, has_delay, delay_category, delay_description,
         delay_photo_url, signature_data_url, status, flag_note,
         reviewed_at, reviewed_by, work_date, created_at,
         subcontractor:users!dockets_subcontractor_id_fkey(id, name, company_name)`
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

      // Optimistic update so the UI feels instant.
      updateLocalDocket(docket.id, {
        status: 'approved',
        flag_note: null,
        reviewed_at: reviewedAt,
        reviewed_by: profile?.id || null,
      });

      try {
        const { error } = await supabase
          .from('dockets')
          .update({
            status: 'approved',
            flag_note: null,
            reviewed_at: reviewedAt,
            reviewed_by: profile?.id || null,
          })
          .eq('id', docket.id);

        if (error) throw error;

        // Hand off to PDF pipeline (no-op stub for now).
        void triggerPdfGeneration(docket.id);
      } catch (err) {
        console.error('[SiteDocketsPage] approve failed', err);
        updateLocalDocket(docket.id, previousSnapshot);
        setActionErrorFor(docket.id, getErrorMessage(err, 'Could not approve docket.'));
      } finally {
        setPendingAction((prev) => {
          const next = { ...prev };
          delete next[docket.id];
          return next;
        });
      }
    },
    [clearActionErrorFor, profile?.id, setActionErrorFor, updateLocalDocket]
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

                {docket.has_delay ? (
                  <div className="mt-4 rounded-lg border border-rose-900/40 bg-rose-950/20 p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-rose-300">
                      Delay
                      {docket.delay_category ? ` \u00b7 ${docket.delay_category}` : ''}
                    </p>
                    {docket.delay_description ? (
                      <p className="mt-1 whitespace-pre-wrap text-sm text-rose-100/90">
                        {docket.delay_description}
                      </p>
                    ) : null}
                    {docket.delay_photo_url ? (
                      <button
                        type="button"
                        onClick={() => setPreviewPhoto(docket.delay_photo_url)}
                        className="mt-3 block overflow-hidden rounded-md border border-rose-900/40"
                      >
                        <img
                          src={docket.delay_photo_url}
                          alt="Delay evidence"
                          className="h-36 w-full object-cover"
                        />
                      </button>
                    ) : null}
                  </div>
                ) : null}

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
                    <p className="font-medium">
                      {status === 'approved' ? 'Approved' : 'Flagged'} on{' '}
                      {formatDateTime(docket.reviewed_at)}
                    </p>
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
