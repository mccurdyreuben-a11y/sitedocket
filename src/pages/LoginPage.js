import React, { useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export function LoginPage() {
  const { user, profile, loading, signIn } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const from = location.state?.from?.pathname;

  if (!loading && user && profile) {
    const dest =
      profile.role === 'contractor' ? '/dashboard' : '/scan';
    return <Navigate to={from && from !== '/login' ? from : dest} replace />;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    const { error: err } = await signIn(email.trim(), password);
    setSubmitting(false);
    if (err) {
      setError(err.message || 'Could not sign in');
      return;
    }
  }

  return (
    <div className="flex min-h-screen flex-col justify-center bg-slate-950 px-4 py-12">
      <div className="mx-auto w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-white">
            SiteDocket
          </h1>
          <p className="mt-1 text-sm text-slate-400">Sign in to your account</p>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-8 shadow-xl shadow-black/40">
          <form onSubmit={handleSubmit} className="space-y-5">
            {error ? (
              <div
                className="rounded-lg border border-red-900/50 bg-red-950/50 px-3 py-2 text-sm text-red-200"
                role="alert"
              >
                {error}
              </div>
            ) : null}

            <div>
              <label
                htmlFor="login-email"
                className="mb-1.5 block text-sm font-medium text-slate-300"
              >
                Email
              </label>
              <input
                id="login-email"
                name="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
            </div>

            <div>
              <label
                htmlFor="login-password"
                className="mb-1.5 block text-sm font-medium text-slate-300"
              >
                Password
              </label>
              <input
                id="login-password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
            </div>

            <button
              type="submit"
              disabled={submitting || loading}
              className="w-full rounded-lg bg-emerald-600 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
            >
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-slate-400">
            No account?{' '}
            <Link
              to="/signup"
              className="font-medium text-emerald-400 hover:text-emerald-300"
            >
              Create one
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
