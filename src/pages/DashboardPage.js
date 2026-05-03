import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { QRCodeCanvas } from 'qrcode.react';
import { LogoutButton } from '../components/LogoutButton';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabaseClient';

export function DashboardPage() {
  const { profile } = useAuth();
  const [sites, setSites] = useState([]);
  const [todayCounts, setTodayCounts] = useState({});
  const [todayStatusBySite, setTodayStatusBySite] = useState({});
  const [loadingSites, setLoadingSites] = useState(true);
  const [listError, setListError] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [form, setForm] = useState({
    siteName: '',
    address: '',
    startDate: '',
  });

  const fetchSites = useCallback(async () => {
    if (!profile?.id) {
      setSites([]);
      setTodayCounts({});
      setTodayStatusBySite({});
      setLoadingSites(false);
      return;
    }

    setLoadingSites(true);
    setListError('');

    try {
      const { data: siteRows, error: sitesError } = await supabase
        .from('sites')
        .select('id, name, address, start_date, created_at')
        .eq('contractor_id', profile.id)
        .order('created_at', { ascending: false });

      if (sitesError) throw sitesError;

      const safeSites = siteRows || [];
      setSites(safeSites);

      if (safeSites.length === 0) {
        setTodayCounts({});
        setTodayStatusBySite({});
        return;
      }

      const siteIds = safeSites.map((site) => site.id);
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const { data: docketRows, error: docketsError } = await supabase
        .from('dockets')
        .select('id, site_id, status, created_at')
        .in('site_id', siteIds)
        .gte('created_at', todayStart.toISOString());

      if (docketsError) throw docketsError;

      const counts = {};
      const latestStatus = {};
      (docketRows || []).forEach((docket) => {
        counts[docket.site_id] = (counts[docket.site_id] || 0) + 1;

        const prev = latestStatus[docket.site_id];
        if (!prev || new Date(docket.created_at) > new Date(prev.created_at)) {
          latestStatus[docket.site_id] = {
            status: docket.status || 'pending',
            created_at: docket.created_at,
          };
        }
      });

      setTodayCounts(counts);
      setTodayStatusBySite(latestStatus);
    } catch (err) {
      console.error(err);
      setListError(err.message || 'Could not load sites');
    } finally {
      setLoadingSites(false);
    }
  }, [profile?.id]);

  useEffect(() => {
    void fetchSites();
  }, [fetchSites]);

  const todayLabel = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }).format(new Date()),
    []
  );

  const closeModal = useCallback(() => {
    setShowCreateModal(false);
    setCreateError('');
    setForm({
      siteName: '',
      address: '',
      startDate: '',
    });
  }, []);

  const handleCreateSite = useCallback(
    async (e) => {
      e.preventDefault();
      setCreateError('');
      setCreating(true);
      try {
        const payload = {
          contractor_id: profile.id,
          name: form.siteName.trim(),
          address: form.address.trim(),
          start_date: form.startDate || null,
        };

        const { error } = await supabase.from('sites').insert(payload);
        if (error) throw error;

        closeModal();
        await fetchSites();
      } catch (err) {
        console.error(err);
        setCreateError(err.message || 'Could not create site');
      } finally {
        setCreating(false);
      }
    },
    [closeModal, fetchSites, form.address, form.siteName, form.startDate, profile?.id]
  );

  const downloadQr = useCallback((siteId) => {
    const canvas = document.getElementById(`site-qr-${siteId}`);
    if (!(canvas instanceof HTMLCanvasElement)) return;
    const url = canvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.href = url;
    link.download = `site-${siteId}-qr.png`;
    link.click();
  }, []);

  const getSiteStatus = useCallback((startDate) => {
    if (!startDate) return { label: 'No start date', tone: 'text-slate-300 bg-slate-700/50' };
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(startDate);
    start.setHours(0, 0, 0, 0);
    if (start > today) return { label: 'Upcoming', tone: 'text-amber-200 bg-amber-700/40' };
    return { label: 'Active', tone: 'text-emerald-200 bg-emerald-700/40' };
  }, []);

  const getDocketStatus = useCallback((siteId) => {
    const count = todayCounts[siteId] || 0;
    if (count === 0) return { label: 'No dockets today', tone: 'text-slate-300 bg-slate-700/50' };
    if (count >= 5) return { label: 'High activity', tone: 'text-cyan-200 bg-cyan-700/40' };
    return { label: 'Normal activity', tone: 'text-indigo-200 bg-indigo-700/40' };
  }, [todayCounts]);

  const getLatestSubmissionStatus = useCallback((siteId) => {
    const rawStatus = todayStatusBySite[siteId]?.status;
    if (!rawStatus) return { label: 'No submissions yet', tone: 'text-slate-300 bg-slate-700/50' };
    const normalized = String(rawStatus).toLowerCase();
    if (normalized.includes('approved')) {
      return { label: 'Latest: Approved', tone: 'text-emerald-200 bg-emerald-700/40' };
    }
    if (normalized.includes('flagged')) {
      return { label: 'Latest: Flagged', tone: 'text-orange-200 bg-orange-700/40' };
    }
    if (normalized.includes('rejected')) {
      return { label: 'Latest: Rejected', tone: 'text-rose-200 bg-rose-700/40' };
    }
    if (normalized.includes('submitted')) {
      return { label: 'Latest: Pending Review', tone: 'text-amber-200 bg-amber-700/40' };
    }
    return { label: `Latest: ${rawStatus}`, tone: 'text-amber-200 bg-amber-700/40' };
  }, [todayStatusBySite]);

  return (
    <div className="min-h-screen bg-slate-950">
      <header className="flex items-center justify-between border-b border-slate-800 px-4 py-4 sm:px-6">
        <div>
          <h1 className="text-lg font-semibold text-white">Dashboard</h1>
          <p className="text-sm text-slate-400">
            {profile?.name}
            {profile?.company_name ? ` · ${profile.company_name}` : ''}
          </p>
        </div>
        <LogoutButton />
      </header>

      <main className="space-y-4 p-4 sm:p-6">
        <div className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-900/50 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-base font-semibold text-white">Your Sites</h2>
            <p className="text-sm text-slate-400">Dockets summary for {todayLabel}</p>
          </div>
          <button
            type="button"
            onClick={() => setShowCreateModal(true)}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500"
          >
            Create New Site
          </button>
        </div>

        {listError ? (
          <div className="rounded-lg border border-rose-900/50 bg-rose-950/50 px-4 py-3 text-sm text-rose-200">
            {listError}
          </div>
        ) : null}

        {loadingSites ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {[...Array(3)].map((_, index) => (
              <div
                key={index}
                className="animate-pulse rounded-xl border border-slate-800 bg-slate-900/50 p-5"
              >
                <div className="mb-4 h-5 w-2/3 rounded bg-slate-700/60" />
                <div className="mb-2 h-4 w-full rounded bg-slate-800/80" />
                <div className="h-4 w-4/5 rounded bg-slate-800/80" />
              </div>
            ))}
          </div>
        ) : null}

        {!loadingSites && sites.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/40 px-6 py-12 text-center">
            <p className="text-base font-medium text-slate-200">No sites yet</p>
            <p className="mt-1 text-sm text-slate-400">
              Create your first site to generate its scan QR code.
            </p>
          </div>
        ) : null}

        {!loadingSites && sites.length > 0 ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {sites.map((site) => {
              const scanUrl = `https://sitedocket.io/scan/${site.id}`;
              const siteStatus = getSiteStatus(site.start_date);
              const docketStatus = getDocketStatus(site.id);
              const latestSubmission = getLatestSubmissionStatus(site.id);
              const todayCount = todayCounts[site.id] || 0;

              return (
                <article
                  key={site.id}
                  className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 shadow-lg shadow-black/20"
                >
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-base font-semibold text-white">{site.name}</h3>
                      <p className="mt-1 text-sm text-slate-400">{site.address}</p>
                    </div>
                  </div>

                  <div className="mb-4 flex flex-wrap gap-2 text-xs font-medium">
                    <span className={`rounded-full px-2.5 py-1 ${siteStatus.tone}`}>{siteStatus.label}</span>
                    <span className={`rounded-full px-2.5 py-1 ${docketStatus.tone}`}>{docketStatus.label}</span>
                    <span className={`rounded-full px-2.5 py-1 ${latestSubmission.tone}`}>
                      {latestSubmission.label}
                    </span>
                  </div>

                  <div className="mb-4 rounded-lg border border-slate-800 bg-slate-950/60 p-3">
                    <p className="text-xs text-slate-400">Dockets Today</p>
                    <p className="mt-1 text-2xl font-semibold text-white">{todayCount}</p>
                  </div>

                  <Link
                    to={`/site/${site.id}/dockets`}
                    className="mb-4 block w-full rounded-lg bg-emerald-600 px-3 py-2 text-center text-sm font-semibold text-white transition hover:bg-emerald-500"
                  >
                    Review Dockets
                  </Link>

                  <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4">
                    <p className="mb-3 text-xs font-medium text-slate-400">Site QR</p>
                    <div className="mb-3 flex items-center justify-center rounded-lg bg-white p-3">
                      <QRCodeCanvas
                        id={`site-qr-${site.id}`}
                        value={scanUrl}
                        size={160}
                        level="M"
                        includeMargin
                      />
                    </div>
                    <p className="truncate text-xs text-slate-500">{scanUrl}</p>
                    <button
                      type="button"
                      onClick={() => downloadQr(site.id)}
                      className="mt-3 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm font-medium text-slate-100 transition hover:bg-slate-700"
                    >
                      Download QR
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : null}
      </main>

      {showCreateModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-lg rounded-xl border border-slate-800 bg-slate-900 p-6 shadow-2xl shadow-black/40">
            <div className="mb-4">
              <h3 className="text-lg font-semibold text-white">Create New Site</h3>
              <p className="text-sm text-slate-400">
                Add site details and generate a QR code automatically.
              </p>
            </div>

            <form onSubmit={handleCreateSite} className="space-y-4">
              {createError ? (
                <div className="rounded-lg border border-rose-900/50 bg-rose-950/50 px-3 py-2 text-sm text-rose-200">
                  {createError}
                </div>
              ) : null}

              <div>
                <label htmlFor="site-name" className="mb-1.5 block text-sm font-medium text-slate-300">
                  Site Name
                </label>
                <input
                  id="site-name"
                  type="text"
                  required
                  value={form.siteName}
                  onChange={(e) => setForm((prev) => ({ ...prev, siteName: e.target.value }))}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                />
              </div>

              <div>
                <label htmlFor="site-address" className="mb-1.5 block text-sm font-medium text-slate-300">
                  Address
                </label>
                <input
                  id="site-address"
                  type="text"
                  required
                  value={form.address}
                  onChange={(e) => setForm((prev) => ({ ...prev, address: e.target.value }))}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                />
              </div>

              <div>
                <label htmlFor="site-start-date" className="mb-1.5 block text-sm font-medium text-slate-300">
                  Start Date
                </label>
                <input
                  id="site-start-date"
                  type="date"
                  required
                  value={form.startDate}
                  onChange={(e) => setForm((prev) => ({ ...prev, startDate: e.target.value }))}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={closeModal}
                  disabled={creating}
                  className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-100 transition hover:bg-slate-700 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
                >
                  {creating ? 'Creating...' : 'Create Site'}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
