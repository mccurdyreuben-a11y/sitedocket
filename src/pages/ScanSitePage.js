import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import SignaturePad from 'signature_pad';
import { Link, useLocation, useParams } from 'react-router-dom';
import { LogoutButton } from '../components/LogoutButton';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabaseClient';

const TRADE_OPTIONS = [
  'Electrician',
  'Plumber',
  'Carpenter',
  'Groundworker',
  'Steelworker',
  'Other',
];

const DELAY_CATEGORIES = [
  'Weather',
  'Access Denied',
  'Materials Not Delivered',
  'Design Issue',
  'Other',
];

function getErrorMessage(err, fallback) {
  if (!err) return fallback;
  if (typeof err === 'string') return err;
  if (typeof err.message === 'string' && err.message.trim()) return err.message;
  if (typeof err.error_description === 'string' && err.error_description.trim()) {
    return err.error_description;
  }
  if (typeof err.details === 'string' && err.details.trim()) return err.details;
  return fallback;
}

function formatToday() {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date());
}

export function ScanSitePage() {
  const { siteId } = useParams();
  const location = useLocation();
  const { user, profile, loading } = useAuth();
  const canvasRef = useRef(null);
  const padRef = useRef(null);

  const [site, setSite] = useState(null);
  const [loadingSite, setLoadingSite] = useState(true);
  const [siteError, setSiteError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [submitSuccess, setSubmitSuccess] = useState('');
  const [delayPhoto, setDelayPhoto] = useState(null);

  const [form, setForm] = useState({
    tradeType: TRADE_OPTIONS[0],
    workDescription: '',
    hoursOnSite: '',
    hasDelay: false,
    delayCategory: DELAY_CATEGORIES[0],
    delayDescription: '',
  });

  const fromState = useMemo(
    () => ({
      from: { pathname: location.pathname },
    }),
    [location.pathname]
  );
  const normalizedSiteId = useMemo(() => {
    if (!siteId) return '';
    const decoded = decodeURIComponent(siteId).trim();
    const bracketMatch = decoded.match(/^\[(.+)\]$/);
    const unwrapped = bracketMatch ? bracketMatch[1] : decoded;
    return unwrapped.replace(/-qr$/i, '');
  }, [siteId]);

  // Initialise (and tear down) the SignaturePad only once the form, and
  // therefore the <canvas>, is actually mounted in the DOM. The earlier
  // implementation ran `initializePad` on first mount when the page was
  // still showing the loading spinner, so canvasRef.current was null and
  // SignaturePad was never constructed — which is why the pad couldn't be
  // drawn on. Depending on the conditions that gate the form render
  // guarantees the canvas exists when this effect fires.
  useEffect(() => {
    if (loading || loadingSite || siteError || !user || !profile) {
      return undefined;
    }

    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const resizeCanvas = () => {
      const ratio = Math.max(window.devicePixelRatio || 1, 1);
      const width = canvas.offsetWidth || 300;
      const height = 200;
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.scale(ratio, ratio);
      // Resetting canvas.width/height wipes any current strokes, so reset
      // signature_pad's internal point buffer to match the now-blank canvas.
      padRef.current?.clear();
    };

    resizeCanvas();

    const pad = new SignaturePad(canvas, {
      minWidth: 1,
      maxWidth: 2.5,
      penColor: '#0f172a',
      backgroundColor: 'rgb(255, 255, 255)',
    });
    padRef.current = pad;

    window.addEventListener('resize', resizeCanvas);

    return () => {
      window.removeEventListener('resize', resizeCanvas);
      pad.off();
      if (padRef.current === pad) {
        padRef.current = null;
      }
    };
  }, [loading, loadingSite, siteError, user, profile]);

  useEffect(() => {
    async function fetchSite() {
      if (!normalizedSiteId) {
        setSiteError('Invalid site link.');
        setLoadingSite(false);
        return;
      }

      setLoadingSite(true);
      setSiteError('');

      const { data, error } = await supabase
        .from('sites')
        .select('id, name, address')
        .eq('id', normalizedSiteId)
        .maybeSingle();

      if (error) {
        const maybePermissionError =
          error.code === '42501' ||
          /row-level security|permission denied|not allowed/i.test(error.message || '');

        // If the user is not signed in yet, still show the login/register panel
        // instead of a hard error screen.
        if (!user && maybePermissionError) {
          setSiteError('');
          setSite(null);
          setLoadingSite(false);
          return;
        }
        console.error(error);
        setSiteError(error.message || 'Could not load site.');
        setLoadingSite(false);
        return;
      }

      if (!data) {
        // With RLS, unauthenticated reads may return 0 rows rather than an explicit
        // permission error. In that case, keep the scan flow alive and prompt login.
        if (!user) {
          setSiteError('');
          setSite(null);
          setLoadingSite(false);
          return;
        }
        setSiteError('Site not found for this QR code.');
        setLoadingSite(false);
        return;
      }

      setSite(data);
      setLoadingSite(false);
    }

    void fetchSite();
  }, [normalizedSiteId, user]);

  const clearSignature = useCallback(() => {
    padRef.current?.clear();
  }, []);

  const handleSubmit = useCallback(
    async (e) => {
      e.preventDefault();
      e.stopPropagation();

      console.log('[ScanSitePage] Submit clicked');

      setSubmitError('');
      setSubmitSuccess('');
      setSubmitting(true);

      try {
        const trimmedWorkDescription = form.workDescription.trim();
        const trimmedDelayDescription = form.delayDescription.trim();
        const parsedHours = Number(form.hoursOnSite);

        if (!user || !profile) {
          throw new Error('Please sign in before submitting a docket.');
        }
        if (profile.role !== 'sub') {
          throw new Error(
            'Only subcontractor accounts can submit dockets from this page.'
          );
        }
        if (!site?.id) {
          throw new Error('Site is missing. Reload and try again.');
        }
        if (!padRef.current || padRef.current.isEmpty()) {
          throw new Error('Please add your digital signature.');
        }
        if (!trimmedWorkDescription) {
          throw new Error('Please add a description of work done.');
        }
        if (!Number.isFinite(parsedHours) || parsedHours < 0) {
          throw new Error('Please enter valid hours on site.');
        }
        if (form.hasDelay && !trimmedDelayDescription) {
          throw new Error('Add a delay description when delay is marked Yes.');
        }

        // Re-verify the auth session right before insert, so an expired token
        // doesn't cause the request to silently fail under RLS.
        const { data: authData, error: authError } =
          await supabase.auth.getUser();
        if (authError) {
          console.error('[ScanSitePage] auth.getUser error', authError);
          throw new Error('Your session has expired. Please sign in again.');
        }
        const authUserId = authData?.user?.id;
        if (!authUserId) {
          throw new Error('Your session has expired. Please sign in again.');
        }

        let delayPhotoUrl = null;
        if (form.hasDelay && delayPhoto) {
          const ext =
            delayPhoto.name.split('.').pop()?.toLowerCase() || 'jpg';
          const filePath = `${site.id}/${authUserId}/${Date.now()}.${ext}`;
          console.log('[ScanSitePage] uploading delay photo', filePath);
          const { error: uploadError } = await supabase.storage
            .from('docket-delays')
            .upload(filePath, delayPhoto, { upsert: false });
          if (uploadError) {
            console.error('[ScanSitePage] storage upload error', uploadError);
            throw uploadError;
          }
          const { data: publicData } = supabase.storage
            .from('docket-delays')
            .getPublicUrl(filePath);
          delayPhotoUrl = publicData?.publicUrl || filePath;
        }

        let signatureDataUrl;
        try {
          signatureDataUrl = padRef.current.toDataURL('image/png');
        } catch (sigErr) {
          console.error('[ScanSitePage] signature export failed', sigErr);
          throw new Error('Could not read the signature. Please re-sign.');
        }

        const payload = {
          site_id: site.id,
          subcontractor_id: authUserId,
          submitted_by_auth_user_id: authUserId,
          trade_type: form.tradeType,
          work_description: trimmedWorkDescription,
          hours_on_site: parsedHours,
          has_delay: form.hasDelay,
          delay_category: form.hasDelay ? form.delayCategory : null,
          delay_description: form.hasDelay ? trimmedDelayDescription : null,
          delay_photo_url: delayPhotoUrl,
          // The dockets table column is `signature_data_url` (see
          // supabase_schema.sql). Do NOT rename without also running a
          // migration — otherwise the insert will fail with a column or
          // not-null violation.
          signature_data_url: signatureDataUrl,
          status: 'submitted',
          work_date: new Date().toISOString().slice(0, 10),
        };

        console.log('[ScanSitePage] inserting docket', {
          ...payload,
          signature_data_url: `<base64 ${signatureDataUrl.length} chars>`,
        });

        // Note: using `.select('id')` (without `.single()`) so an RLS-filtered
        // post-insert read can't masquerade as a generic "no rows" error.
        const { data: insertData, error: insertError } = await supabase
          .from('dockets')
          .insert(payload)
          .select('id');

        if (insertError) {
          console.error('[ScanSitePage] insert error', insertError);
          throw insertError;
        }

        console.log('[ScanSitePage] insert ok', insertData);

        setSubmitSuccess('Docket submitted successfully.');
        setForm({
          tradeType: TRADE_OPTIONS[0],
          workDescription: '',
          hoursOnSite: '',
          hasDelay: false,
          delayCategory: DELAY_CATEGORIES[0],
          delayDescription: '',
        });
        setDelayPhoto(null);
        clearSignature();
      } catch (err) {
        console.error('[ScanSitePage] submit failed', err);
        const message = getErrorMessage(err, 'Could not submit docket.');
        setSubmitError(message);
        // Make sure the user actually sees the message even if they're
        // scrolled to the bottom of a long form.
        if (typeof window !== 'undefined') {
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
      } finally {
        setSubmitting(false);
      }
    },
    [clearSignature, delayPhoto, form, profile, site, user]
  );

  if (loading || loadingSite) {
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
          <p className="text-lg font-semibold text-rose-200">Scan Error</p>
          <p className="mt-2 text-sm text-rose-100/80">{siteError}</p>
          <Link
            to="/login"
            className="mt-5 inline-block rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500"
          >
            Go to Login
          </Link>
        </div>
      </div>
    );
  }

  if (!user || !profile) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 px-4">
        <div className="w-full max-w-lg rounded-xl border border-slate-800 bg-slate-900/70 p-6 text-center">
          <p className="text-lg font-semibold text-white">Sign in to submit your docket</p>
          <p className="mt-2 text-sm text-slate-400">
            Site: <span className="text-slate-200">{site?.name}</span>
          </p>
          <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
            <Link
              to="/login"
              state={fromState}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500"
            >
              Log In
            </Link>
            <Link
              to="/signup"
              state={fromState}
              className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-semibold text-slate-100 hover:bg-slate-700"
            >
              Quick Register
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950">
      <header className="flex items-center justify-between border-b border-slate-800 px-4 py-4 sm:px-6">
        <div>
          <h1 className="text-lg font-semibold text-white">Submit Docket</h1>
          <p className="text-sm text-slate-400">
            {site?.name} · {formatToday()}
          </p>
        </div>
        <LogoutButton />
      </header>

      <main className="mx-auto w-full max-w-3xl p-4 sm:p-6">
        <div className="mb-4 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
          <p className="text-sm text-slate-300">
            <span className="font-medium text-white">Site:</span> {site?.name}
          </p>
          <p className="mt-1 text-sm text-slate-400">{site?.address}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/60 p-5">
          {submitError ? (
            <div className="rounded-lg border border-rose-900/50 bg-rose-950/50 px-3 py-2 text-sm text-rose-200">
              {submitError}
            </div>
          ) : null}
          {submitSuccess ? (
            <div className="rounded-lg border border-emerald-900/50 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-200">
              {submitSuccess}
            </div>
          ) : null}

          <div>
            <label htmlFor="trade-type" className="mb-1.5 block text-sm font-medium text-slate-300">
              Trade Type
            </label>
            <select
              id="trade-type"
              value={form.tradeType}
              onChange={(e) => setForm((prev) => ({ ...prev, tradeType: e.target.value }))}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            >
              {TRADE_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="work-description" className="mb-1.5 block text-sm font-medium text-slate-300">
              Description of work done
            </label>
            <textarea
              id="work-description"
              required
              rows={4}
              value={form.workDescription}
              onChange={(e) => setForm((prev) => ({ ...prev, workDescription: e.target.value }))}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
          </div>

          <div>
            <label htmlFor="hours-on-site" className="mb-1.5 block text-sm font-medium text-slate-300">
              Hours on site
            </label>
            <input
              id="hours-on-site"
              type="number"
              inputMode="decimal"
              min="0"
              step="0.25"
              required
              value={form.hoursOnSite}
              onChange={(e) => setForm((prev) => ({ ...prev, hoursOnSite: e.target.value }))}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
          </div>

          <section className="rounded-lg border border-slate-800 bg-slate-950/60 p-4">
            <h2 className="text-sm font-semibold text-white">Delays</h2>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => setForm((prev) => ({ ...prev, hasDelay: false }))}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                  !form.hasDelay ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-300'
                }`}
              >
                No
              </button>
              <button
                type="button"
                onClick={() => setForm((prev) => ({ ...prev, hasDelay: true }))}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                  form.hasDelay ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-300'
                }`}
              >
                Yes
              </button>
            </div>

            {form.hasDelay ? (
              <div className="mt-4 space-y-3">
                <div>
                  <label htmlFor="delay-category" className="mb-1.5 block text-sm font-medium text-slate-300">
                    Delay Category
                  </label>
                  <select
                    id="delay-category"
                    value={form.delayCategory}
                    onChange={(e) => setForm((prev) => ({ ...prev, delayCategory: e.target.value }))}
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2.5 text-slate-100 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  >
                    {DELAY_CATEGORIES.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="delay-description" className="mb-1.5 block text-sm font-medium text-slate-300">
                    Delay Description
                  </label>
                  <textarea
                    id="delay-description"
                    rows={3}
                    value={form.delayDescription}
                    onChange={(e) => setForm((prev) => ({ ...prev, delayDescription: e.target.value }))}
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2.5 text-slate-100 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  />
                </div>

                <div>
                  <label htmlFor="delay-photo" className="mb-1.5 block text-sm font-medium text-slate-300">
                    Delay Photo
                  </label>
                  <input
                    id="delay-photo"
                    type="file"
                    accept="image/*"
                    onChange={(e) => setDelayPhoto(e.target.files?.[0] || null)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2.5 text-sm text-slate-200 file:mr-3 file:rounded-md file:border-0 file:bg-emerald-600 file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-white"
                  />
                  {delayPhoto ? (
                    <p className="mt-1 text-xs text-slate-400">Selected: {delayPhoto.name}</p>
                  ) : null}
                </div>
              </div>
            ) : null}
          </section>

          <section>
            <div className="mb-1.5 flex items-center justify-between">
              <label className="block text-sm font-medium text-slate-300">Digital Signature</label>
              <button
                type="button"
                onClick={clearSignature}
                className="rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-slate-700"
              >
                Clear
              </button>
            </div>
            <div className="rounded-lg border border-slate-700 bg-white p-2">
              <canvas
                ref={canvasRef}
                className="block w-full rounded"
                style={{ touchAction: 'none', height: 200 }}
              />
            </div>
          </section>

          {submitError ? (
            <div className="rounded-lg border border-rose-900/50 bg-rose-950/50 px-3 py-2 text-sm text-rose-200">
              {submitError}
            </div>
          ) : null}
          {submitSuccess ? (
            <div className="rounded-lg border border-emerald-900/50 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-200">
              {submitSuccess}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-emerald-600 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
          >
            {submitting ? 'Submitting...' : 'Submit'}
          </button>
        </form>
      </main>
    </div>
  );
}
