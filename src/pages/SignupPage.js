import React, { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export function SignupPage() {
  const { user, profile, loading, signUp } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = location.state?.from?.pathname;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [role, setRole] = useState(
    /** @type {'contractor' | 'sub'} */ ('contractor')
  );
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [emailConfirmMessage, setEmailConfirmMessage] = useState(false);

  if (!loading && user && profile && !emailConfirmMessage) {
    const dest = profile.role === 'contractor' ? '/dashboard' : '/scan';
    return <Navigate to={dest} replace />;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setEmailConfirmMessage(false);
    setSubmitting(true);
    const { error: err, needsEmailConfirmation } = await signUp(
      email.trim(),
      password,
      fullName.trim(),
      companyName.trim(),
      role
    );
    setSubmitting(false);
    if (err) {
      setError(err.message || 'Could not create account');
      return;
    }
    if (needsEmailConfirmation) {
      setEmailConfirmMessage(true);
      return;
    }
    const dest = role === 'contractor'
      ? '/dashboard'
      : from && from.startsWith('/scan/') ? from : '/scan';
    navigate(dest, { replace: true });
  }

  if (emailConfirmMessage) {
    return (
      <div className="flex min-h-screen flex-col justify-center bg-slate-950 px-4 py-12">
        <div className="mx-auto w-full max-w-md text-center">
          <h1 className="text-xl font-semibold text-white">Check your email</h1>
          <p className="mt-3 text-sm text-slate-400">
            We sent a confirmation link to <strong className="text-slate-200">{email}</strong>.
            After you confirm, sign in and your profile will be created automatically.
          </p>
          <Link
            to="/login"
            state={location.state}
            className="mt-6 inline-block text-sm font-medium text-emerald-400 hover:text-emerald-300"
          >
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col justify-center bg-slate-950 px-4 py-12">
      <div className="mx-auto w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-white">
            Create account
          </h1>
          <p className="mt-1 text-sm text-slate-400">Join SiteDocket</p>
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
              <span className="mb-2 block text-sm font-medium text-slate-300">
                Role
              </span>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 has-[:checked]:border-emerald-500 has-[:checked]:ring-1 has-[:checked]:ring-emerald-500">
                  <input
                    type="radio"
                    name="role"
                    value="contractor"
                    checked={role === 'contractor'}
                    onChange={() => setRole('contractor')}
                    className="text-emerald-500 focus:ring-emerald-500"
                  />
                  <span className="text-sm text-slate-200">
                    Main Contractor
                  </span>
                </label>
                <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 has-[:checked]:border-emerald-500 has-[:checked]:ring-1 has-[:checked]:ring-emerald-500">
                  <input
                    type="radio"
                    name="role"
                    value="sub"
                    checked={role === 'sub'}
                    onChange={() => setRole('sub')}
                    className="text-emerald-500 focus:ring-emerald-500"
                  />
                  <span className="text-sm text-slate-200">Subcontractor</span>
                </label>
              </div>
            </div>

            <div>
              <label
                htmlFor="signup-email"
                className="mb-1.5 block text-sm font-medium text-slate-300"
              >
                Email
              </label>
              <input
                id="signup-email"
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
                htmlFor="signup-password"
                className="mb-1.5 block text-sm font-medium text-slate-300"
              >
                Password
              </label>
              <input
                id="signup-password"
                name="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
            </div>

            <div>
              <label
                htmlFor="signup-fullname"
                className="mb-1.5 block text-sm font-medium text-slate-300"
              >
                Full name
              </label>
              <input
                id="signup-fullname"
                name="fullName"
                type="text"
                autoComplete="name"
                required
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
            </div>

            <div>
              <label
                htmlFor="signup-company"
                className="mb-1.5 block text-sm font-medium text-slate-300"
              >
                Company name
              </label>
              <input
                id="signup-company"
                name="companyName"
                type="text"
                autoComplete="organization"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                placeholder="Optional"
              />
            </div>

            <button
              type="submit"
              disabled={submitting || loading}
              className="w-full rounded-lg bg-emerald-600 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
            >
              {submitting ? 'Creating account…' : 'Create account'}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-slate-400">
            Already registered?{' '}
            <Link
              to="/login"
              state={location.state}
              className="font-medium text-emerald-400 hover:text-emerald-300"
            >
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
